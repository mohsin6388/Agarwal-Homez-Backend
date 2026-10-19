const { Parser: CsvParser } = require("json2csv");
const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Lead = require("../models/Lead");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const EmailMessage = require("../models/EmailMessage");
const OutboundJob = require("../models/OutboundJob");
const Meeting = require("../models/Meeting");
const AuditLog = require("../models/AuditLog");
const {
  parseCsvBuffer,
  parseExcelBuffer,
  parseLeadText,
  analyzeRows,
} = require("../services/csv/leadImporter");
const { importLeadRows } = require("../services/leads/leadImportService");
const { toWhatsAppNumber } = require("../services/whatsapp/metaWhatsappClient");
const { enqueueLeads } = require("../services/queue/outboundQueue");
const { writeXlsxBuffer } = require("../services/csv/xlsxWriter");

/**
 * Scoping helper: brokers only ever see/act on their own leads.
 * Admins can pass ?ownerId= to view a specific broker's leads; builders
 * don't own leads at all (they view leads via property-match reporting,
 * not this resource) — enforced in the route via roleGuard.
 */
function scopeToOwner(req) {
  if (req.user.role === "admin" && req.query.ownerId) {
    return { ownerId: req.query.ownerId };
  }
  return { ownerId: req.user.id };
}

const AUTO_REPLY_SOURCE =
  /(automatic reply|auto.?reply|out of office|do not reply|no.?reply|i am an ai|virtual assistant|leave a message|not monitored|on leave until)/i;

function asObjectId(value) {
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));
}

// WhatsApp messages have no ownerId of their own. Join through Conversation,
// then Lead, so reply counts and qualification can never leak across brokers.
async function aggregateWhatsAppReplies(ownerId) {
  const ownerObjectId = asObjectId(ownerId);
  // Start from this owner's conversations so the lookup is owner-scoped before
  // touching Message rows. Message has an index on conversationId/timestamp.
  return Conversation.aggregate([
    { $match: { ownerId: ownerObjectId } },
    {
      $lookup: {
        from: Message.collection.name,
        let: { conversationId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$conversationId", "$$conversationId"] },
              direction: "inbound",
              sender: "customer",
            },
          },
          { $sort: { timestamp: -1, createdAt: -1 } },
        ],
        as: "inboundMessages",
      },
    },
    { $unwind: "$inboundMessages" },
    {
      $sort: {
        "inboundMessages.timestamp": -1,
        "inboundMessages.createdAt": -1,
      },
    },
    {
      $group: {
        _id: "$inboundMessages.leadId",
        inboundCount: { $sum: 1 },
        autoCount: {
          $sum: {
            $cond: [
              {
                $regexMatch: {
                  input: { $ifNull: ["$inboundMessages.text", ""] },
                  regex: AUTO_REPLY_SOURCE.source,
                  options: "i",
                },
              },
              1,
              0,
            ],
          },
        },
        humanCount: {
          $sum: {
            $cond: [
              {
                $regexMatch: {
                  input: { $ifNull: ["$inboundMessages.text", ""] },
                  regex: AUTO_REPLY_SOURCE.source,
                  options: "i",
                },
              },
              0,
              1,
            ],
          },
        },
        lastReplyAt: {
          $first: {
            $ifNull: [
              "$inboundMessages.timestamp",
              "$inboundMessages.createdAt",
            ],
          },
        },
        lastResponseText: { $first: "$inboundMessages.text" },
      },
    },
    {
      $lookup: {
        from: Lead.collection.name,
        localField: "_id",
        foreignField: "_id",
        as: "lead",
      },
    },
    { $unwind: "$lead" },
    { $match: { "lead.ownerId": ownerObjectId, "lead.inCrm": { $ne: false } } },
    {
      $project: {
        _id: 1,
        inboundCount: 1,
        autoCount: 1,
        humanCount: 1,
        lastReplyAt: 1,
        lastResponseText: 1,
      },
    },
  ]);
}

async function aggregateEmailReplies(ownerId) {
  const ownerObjectId = asObjectId(ownerId);
  return EmailMessage.aggregate([
    {
      $match: {
        ownerId: ownerObjectId,
        direction: "inbound",
        kind: "received",
        leadId: { $ne: null },
      },
    },
    { $sort: { receivedAt: -1, createdAt: -1 } },
    {
      $group: {
        _id: "$leadId",
        lastReplyAt: { $first: { $ifNull: ["$receivedAt", "$createdAt"] } },
        lastResponseText: {
          $first: {
            $cond: [
              { $ne: [{ $ifNull: ["$text", ""] }, ""] },
              "$text",
              "$subject",
            ],
          },
        },
      },
    },
    {
      $lookup: {
        from: Lead.collection.name,
        localField: "_id",
        foreignField: "_id",
        as: "lead",
      },
    },
    { $unwind: "$lead" },
    { $match: { "lead.ownerId": ownerObjectId, "lead.inCrm": { $ne: false } } },
    { $project: { _id: 1, lastReplyAt: 1, lastResponseText: 1 } },
  ]);
}

async function countSentLeads(ownerId, channel) {
  const ownerObjectId = asObjectId(ownerId);
  const rows = await OutboundJob.aggregate([
    { $match: { ownerId: ownerObjectId, channel, status: "sent" } },
    { $group: { _id: "$leadId" } },
    {
      $lookup: {
        from: Lead.collection.name,
        localField: "_id",
        foreignField: "_id",
        as: "lead",
      },
    },
    { $unwind: "$lead" },
    { $match: { "lead.ownerId": ownerObjectId, "lead.inCrm": { $ne: false } } },
    { $count: "count" },
  ]);
  return rows[0]?.count || 0;
}

function responseMap(whatsappReplies, emailReplies) {
  const map = new Map();
  const attach = (entry, channel) => {
    const id = String(entry._id);
    const existing = map.get(id) || {
      whatsappReplyAt: null,
      emailReplyAt: null,
      lastReplyAt: null,
      lastResponseText: "",
    };
    const date = entry.lastReplyAt ? new Date(entry.lastReplyAt) : null;
    const currentDate = existing.lastReplyAt
      ? new Date(existing.lastReplyAt)
      : null;
    if (channel === "whatsapp")
      existing.whatsappReplyAt = entry.lastReplyAt || null;
    else existing.emailReplyAt = entry.lastReplyAt || null;
    if (date && (!currentDate || date > currentDate)) {
      existing.lastReplyAt = entry.lastReplyAt;
      existing.lastResponseText = String(entry.lastResponseText || "").trim();
    }
    map.set(id, existing);
  };
  whatsappReplies.forEach((entry) => attach(entry, "whatsapp"));
  emailReplies.forEach((entry) => attach(entry, "email"));
  return map;
}

async function getQualifiedLeadRows({ ownerId, query = {} }) {
  const ownerObjectId = asObjectId(ownerId);
  // Qualified Leads are based only on real customer replies in WhatsApp.
  // Preserve the existing automatic-reply filter: one human reply qualifies,
  // or repeated automatic replies qualify after the existing threshold.
  const whatsappReplies = await aggregateWhatsAppReplies(ownerObjectId);
  const qualifiesAsWhatsApp = (entry) =>
    entry.humanCount >= 1 || entry.autoCount >= 3;
  const whatsappReplyIds = new Set(
    whatsappReplies
      .filter(qualifiesAsWhatsApp)
      .map((entry) => String(entry._id)),
  );

  // A lead must have both (1) a qualifying WhatsApp inbound reply and
  // (2) at least one WhatsApp OutboundJob successfully marked sent.
  const repliedObjectIds = [...whatsappReplyIds].map((id) => asObjectId(id));
  const sentWhatsAppIds = repliedObjectIds.length
    ? await OutboundJob.distinct("leadId", {
        ownerId: ownerObjectId,
        channel: "whatsapp",
        status: "sent",
        leadId: { $in: repliedObjectIds },
      })
    : [];
  const sentWhatsAppIdSet = new Set(sentWhatsAppIds.map((id) => String(id)));
  const eligibleLeadIds = [...whatsappReplyIds]
    .filter((id) => sentWhatsAppIdSet.has(id))
    .map((id) => asObjectId(id));

  const baseFilter = {
    ownerId: ownerObjectId,
    inCrm: { $ne: false },
    _id: { $in: eligibleLeadIds },
  };
  if (query.search) {
    const escaped = String(query.search)
      .trim()
      .slice(0, 120)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped) {
      const re = new RegExp(escaped, "i");
      baseFilter.$and = [
        {
          $or: [
            { name: re },
            { phone: re },
            { email: re },
            { city: re },
            { address: re },
            { occupation: re },
          ],
        },
      ];
    }
  }

  const [allQualified, allEligibleMeetings] = await Promise.all([
    Lead.aggregate([{ $match: baseFilter }]),
    Meeting.aggregate([
      {
        $match: {
          ownerId: ownerObjectId,
          bookedBy: "whatsapp_ai",
          status: { $ne: "cancelled" },
        },
      },
      { $group: { _id: "$leadId" } },
    ]),
  ]);
  const leadIds = allQualified.map((lead) => lead._id);
  const sentJobs = leadIds.length
    ? await OutboundJob.find({
        ownerId: ownerObjectId,
        leadId: { $in: leadIds },
        channel: { $in: ["whatsapp", "email"] },
        status: "sent",
      })
        .select("leadId channel sentAt updatedAt")
        .lean()
    : [];
  const sentByLead = new Map();
  sentJobs.forEach((job) => {
    const id = String(job.leadId);
    const current = sentByLead.get(id) || {};
    if (job.channel === "whatsapp") {
      current.whatsappSent = true;
      current.whatsappSentAt ||= job.sentAt || job.updatedAt || null;
    }
    if (job.channel === "email") {
      current.emailSent = true;
      current.emailSentAt ||= job.sentAt || job.updatedAt || null;
    }
    sentByLead.set(id, current);
  });
  const visitIds = new Set(
    allEligibleMeetings.map((entry) => String(entry._id)),
  );
  const replyInfo = responseMap(
    whatsappReplies.filter(qualifiesAsWhatsApp),
    [],
  );
  const enriched = allQualified.map((lead) => {
    const reply = replyInfo.get(String(lead._id)) || {};
    const score = Number(lead.leadScore || 0);
    const temperature = score > 60 ? "hot" : score > 30 ? "warm" : "cold";
    return {
      ...lead,
      ...(sentByLead.get(String(lead._id)) || {}),
      // Keep these fields in the API for backwards compatibility with any
      // other consumer, but the Qualified Leads UI/export no longer shows them.
      lastResponseText: reply.lastResponseText || "",
      lastReplyAt: reply.lastReplyAt || null,
      whatsappReplyAt: reply.whatsappReplyAt || null,
      emailReplyAt: null,
      hasWhatsAppReply: whatsappReplyIds.has(String(lead._id)),
      isVisitLead: visitIds.has(String(lead._id)),
      temperature,
      tag: temperature,
    };
  });

  const tabCounts = {
    all: enriched.length,
    hot: enriched.filter((lead) => Number(lead.leadScore || 0) > 60).length,
    warm: enriched.filter(
      (lead) =>
        Number(lead.leadScore || 0) > 30 && Number(lead.leadScore || 0) <= 60,
    ).length,
    cold: enriched.filter((lead) => Number(lead.leadScore || 0) <= 30).length,
    // Preserve the old count key for any older frontend still deployed.
    visit: enriched.filter((lead) => lead.isVisitLead).length,
  };
  // Preserve the original tab values (all/hot/visit). Temperature is a
  // separate, validated dropdown filter so unsupported tab values never reach
  // this controller.
  const requestedTab = ["all", "hot", "visit"].includes(query.tab)
    ? query.tab
    : "all";
  let filtered = enriched;
  if (requestedTab === "hot")
    filtered = filtered.filter((lead) => Number(lead.leadScore || 0) > 60);
  if (requestedTab === "visit")
    filtered = filtered.filter((lead) => lead.isVisitLead);

  const requestedTemperature = ["hot", "warm", "cold"].includes(
    query.temperature,
  )
    ? query.temperature
    : "all";
  if (requestedTemperature === "hot")
    filtered = filtered.filter((lead) => Number(lead.leadScore || 0) > 60);
  if (requestedTemperature === "warm")
    filtered = filtered.filter(
      (lead) =>
        Number(lead.leadScore || 0) > 30 && Number(lead.leadScore || 0) <= 60,
    );
  if (requestedTemperature === "cold")
    filtered = filtered.filter((lead) => Number(lead.leadScore || 0) <= 30);

  const sortBy = query.sortBy === "name" ? "name" : "leadScore";
  filtered.sort((a, b) => {
    if (sortBy === "name")
      return String(a.name || "").localeCompare(String(b.name || ""), "en", {
        sensitivity: "base",
      });
    return Number(b.leadScore || 0) - Number(a.leadScore || 0);
  });
  return {
    rows: filtered,
    tabCounts,
    replyInfo,
    whatsappReplies,
    emailReplies: [],
  };
}

/**
 * POST /api/leads/import/preview
 * Upload a CSV, get back every row annotated as valid/invalid/duplicate.
 * Nothing is written to the DB at this step.
 */
const previewImport = asyncHandler(async (req, res) => {
  if (!req.file)
    throw ApiError.badRequest(
      'CSV ya Excel file zaroori hai (field name: "file")',
    );

  let rows;
  const filename = String(req.file.originalname || "").toLowerCase();
  try {
    rows = filename.endsWith(".xlsx")
      ? parseExcelBuffer(req.file.buffer)
      : parseCsvBuffer(req.file.buffer);
  } catch (err) {
    throw ApiError.badRequest(err.message);
  }

  const sourceType = filename.endsWith(".xlsx") ? "excel" : "csv";
  const sourceFile = String(req.file.originalname || "")
    .replace(/[\/\\]/g, "_")
    .slice(0, 255);
  const { rows: analyzed, summary } = await analyzeRows(req.user.id, rows);

  return new ApiResponse(
    200,
    {
      rows: analyzed.map((row) => ({ ...row, sourceType, sourceFile })),
      summary,
      sourceType,
      sourceFile,
    },
    "CSV parsed",
  ).send(res);
});

/**
 * POST /api/leads/import/parse-text
 * Body: { text } — har line mein name + phone (+ email) kisi bhi order mein.
 * Response CSV preview jaisa hi hai (valid / invalid / duplicate per row).
 */
const previewText = asyncHandler(async (req, res) => {
  const rows = parseLeadText(req.body.text);
  if (!rows.length)
    throw ApiError.badRequest("No leads found in the pasted text");

  const { rows: analyzed, summary } = await analyzeRows(req.user.id, rows);
  return new ApiResponse(200, { rows: analyzed, summary }, "Text parsed").send(
    res,
  );
});

/**
 * POST /api/leads/import/confirm
 * Client sends back the rows it wants imported (typically the "valid" subset
 * from the preview step, possibly after manual edits). Duplicate-safe via
 * insertMany({ ordered: false }) + the unique (ownerId, phone) index.
 */
const confirmImport = asyncHandler(async (req, res) => {
  const { rows, sourceType, sourceFile } = req.body;
  const ownerId = req.user.id;

  const { inserted, skipped } = await importLeadRows(ownerId, rows, {
    sourceType,
    sourceFile,
  });

  await AuditLog.create({
    userId: req.user.id,
    action: "lead.import",
    entityType: "Lead",
    meta: { insertedCount: inserted.length, skipped },
    ip: req.ip,
  });

  // Uploading data never sends a WhatsApp or email message. The user selects
  // contacts and starts a channel-specific campaign later from WhatsApp/Email.
  return new ApiResponse(
    201,
    {
      insertedCount: inserted.length,
      skipped,
      leadIds: inserted.map((lead) => lead._id),
    },
    `Imported ${inserted.length} leads${skipped ? `, skipped ${skipped} duplicates` : ""}. No messages were sent.`,
  ).send(res);
});

/**
 * POST /api/leads/start-conversations
 * Body: { leadIds: [...] }
 * Kicks off the opening WhatsApp message for a batch of leads (typically
 * the leadIds just returned by /import/confirm, once the broker clicks
 * "Start") — or for any lead whose conversation hasn't been started yet.
 * Safe to call more than once: startConversation() no-ops for leads that
 * already have messages.
 */

const startConversations = asyncHandler(async (req, res) => {
  const { leadIds } = req.body;

  if (!Array.isArray(leadIds) || !leadIds.length) {
    throw ApiError.badRequest("leadIds is required");
  }

  const ownerId = req.user.id;

  // Only allow leads belonging to the logged-in broker.
  const leads = await Lead.find({
    _id: { $in: leadIds },
    ownerId,
    phone: { $type: "string" },
  }).select("_id");

  if (!leads.length) {
    throw ApiError.badRequest("No valid leads found");
  }

  const validLeadIds = leads.map((lead) => lead._id);

  // Only queue leads that have a conversation.
  const conversations = await Conversation.find({
    ownerId,
    leadId: { $in: validLeadIds },
  })
    .select("leadId")
    .lean();

  const leadIdsWithConversation = conversations.map(
    (conversation) => conversation.leadId,
  );

  const queueResult = await enqueueLeads({
    ownerId,
    leadIds: leadIdsWithConversation,
  });

  return new ApiResponse(
    200,
    {
      queued: queueResult.queued,
      skipped: queueResult.skipped,
      batchId: queueResult.batchId,
    },
    `Queued ${queueResult.queued} lead(s) for WhatsApp messaging`,
  ).send(res);
});

// const startConversations = asyncHandler(async (req, res) => {
//   const { leadIds } = req.body;
//   if (!Array.isArray(leadIds) || !leadIds.length) throw ApiError.badRequest('leadIds is required');

//   const ownerId = req.user.id;
//   const leads = await Lead.find({ _id: { $in: leadIds }, ownerId });
//   const leadById = new Map(leads.map((l) => [l._id.toString(), l]));

//   const conversations = await Conversation.find({ leadId: { $in: leads.map((l) => l._id) } });

//   let started = 0;
//   for (const conversation of conversations) {
//     const lead = leadById.get(conversation.leadId.toString());
//     if (!lead) continue;
//     started += 1;
//     conversationEngine.startConversation({ lead, conversation }).catch((err) =>
//       logger.error(`[leads] Failed to start WhatsApp conversation for lead ${lead._id}`, { error: err.message })
//     );
//   }

//   return new ApiResponse(200, { queued: started }, `Starting conversations for ${started} lead(s)`).send(res);
// });

/**
 * POST /api/leads
 */

const createLead = asyncHandler(async (req, res) => {
  let phone = null;
  try {
    if (req.body.phone && String(req.body.phone).trim())
      phone = toWhatsAppNumber(req.body.phone);
  } catch (err) {
    throw ApiError.badRequest(err.message || "Enter a valid phone number");
  }
  const email =
    String(req.body.email || "")
      .trim()
      .toLowerCase() || undefined;
  if (!phone && !email) throw ApiError.badRequest("Phone or email is required");

  if (phone && (await Lead.findOne({ ownerId: req.user.id, phone }))) {
    throw ApiError.conflict("A lead with this phone number already exists");
  }
  if (email && (await Lead.findOne({ ownerId: req.user.id, email }))) {
    throw ApiError.conflict("A lead with this email address already exists");
  }

  const name =
    String(req.body.name || "").trim() ||
    (email
      ? email
          .split("@")[0]
          .replace(/[._+-]+/g, " ")
          .trim()
      : `Lead ${String(phone || "")
          .replace(/\D/g, "")
          .slice(-4)}`) ||
    "New lead";
  const lead = await Lead.create({
    ...req.body,
    name: name.slice(0, 150),
    phone,
    email,
    sourceType: "manual",
    sourceFile: "",
    inCrm: true,
    ownerId: req.user.id,
  });
  if (phone)
    await Conversation.updateOne(
      { ownerId: lead.ownerId, leadId: lead._id },
      { $setOnInsert: { ownerId: lead.ownerId, leadId: lead._id } },
      { upsert: true },
    );

  return new ApiResponse(
    201,
    {
      lead,
      queued: 0,
      batchId: null,
      availableChannels: { whatsapp: Boolean(phone), email: Boolean(email) },
    },
    "Lead saved. No message was sent; launch a campaign when ready.",
  ).send(res);
});

/**
 * GET /api/leads
 */
const listLeads = asyncHandler(async (req, res) => {
  const {
    page,
    limit,
    search,
    status,
    city,
    tag,
    sortBy,
    sortOrder,
    qualifiedOnly,
  } = req.query;

  if (
    String(qualifiedOnly || "") === "1" ||
    String(qualifiedOnly || "").toLowerCase() === "true"
  ) {
    const { rows, tabCounts, whatsappReplies, emailReplies } =
      await getQualifiedLeadRows({
        ownerId: scopeToOwner(req).ownerId,
        query: {
          tab: req.query.tab,
          temperature: req.query.temperature,
          sortBy: req.query.sortBy,
          search: req.query.search,
          replyChannel: req.query.replyChannel,
        },
      });
    const pageNumber = Number(page || 1);
    const pageLimit = Number(limit || 50);
    const paged = rows.slice(
      (pageNumber - 1) * pageLimit,
      pageNumber * pageLimit,
    );
    const [whatsappSent, emailSent] = await Promise.all([
      countSentLeads(scopeToOwner(req).ownerId, "whatsapp"),
      countSentLeads(scopeToOwner(req).ownerId, "email"),
    ]);
    const replied = new Set(
      [...whatsappReplies, ...emailReplies].map((entry) => String(entry._id)),
    ).size;
    return new ApiResponse(200, {
      leads: paged,
      summary: {
        total: rows.length,
        whatsappSent,
        emailSent,
        replied,
        whatsappReplies: whatsappReplies.length,
        emailReplies: emailReplies.length,
        tabCounts,
      },
      tabCounts,
      pagination: {
        page: pageNumber,
        limit: pageLimit,
        total: rows.length,
        totalPages: Math.ceil(rows.length / pageLimit),
      },
    }).send(res);
  }

  const filter = { ...scopeToOwner(req), inCrm: { $ne: false } };
  if (req.query.sourceFile) {
    if (req.query.sourceFile === "manual") {
      filter.$and = [
        ...(filter.$and || []),
        { $or: [{ sourceType: "manual" }, { sourceType: { $exists: false } }] },
      ];
    } else {
      filter.sourceFile = req.query.sourceFile;
    }
  }
  const idClauses = [];
  if (status) filter.status = status;
  const channel = ["whatsapp", "email"].includes(
    String(req.query.channel || ""),
  )
    ? String(req.query.channel)
    : "";
  const delivery = ["sent", "unsent"].includes(String(req.query.delivery || ""))
    ? String(req.query.delivery)
    : "";
  if (channel === "whatsapp") filter.phone = { $type: "string", $ne: "" };
  if (channel === "email") filter.email = { $type: "string", $ne: "" };
  if (channel && delivery) {
    const sentLeadIds = await OutboundJob.distinct("leadId", {
      ownerId: scopeToOwner(req).ownerId,
      channel,
      status: "sent",
    });
    idClauses.push({
      _id: delivery === "sent" ? { $in: sentLeadIds } : { $nin: sentLeadIds },
    });
  }

  if (idClauses.length) filter.$and = [...(filter.$and || []), ...idClauses];
  if (city) filter.city = new RegExp(`^${city}$`, "i");
  if (tag) filter.tags = tag;
  if (search) {
    const escaped = String(search)
      .trim()
      .slice(0, 120)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped) {
      const re = new RegExp(escaped, "i");
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { city: re },
        { notes: re },
        { requirements: re },
        { address: re },
        { occupation: re },
      ];
    }
  }

  const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

  const ownerFilter = { ...scopeToOwner(req), inCrm: { $ne: false } };
  const queryOwnerId = ownerFilter.ownerId;
  const hasPhone = { phone: { $type: "string", $ne: "" } };
  const hasEmail = { email: { $type: "string", $ne: "" } };
  const noPhone = {
    $or: [{ phone: { $exists: false } }, { phone: null }, { phone: "" }],
  };
  const noEmail = {
    $or: [{ email: { $exists: false } }, { email: null }, { email: "" }],
  };
  const [
    leads,
    total,
    allLeads,
    whatsappAvailable,
    emailAvailable,
    bothAvailable,
    whatsappOnly,
    emailOnly,
    siteVisits,
  ] = await Promise.all([
    Lead.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Lead.countDocuments(filter),
    Lead.countDocuments(ownerFilter),
    Lead.countDocuments({ ...ownerFilter, ...hasPhone }),
    Lead.countDocuments({ ...ownerFilter, ...hasEmail }),
    Lead.countDocuments({ ...ownerFilter, ...hasPhone, ...hasEmail }),
    Lead.countDocuments({ ...ownerFilter, ...hasPhone, ...noEmail }),
    Lead.countDocuments({ ...ownerFilter, ...hasEmail, ...noPhone }),
    Lead.countDocuments({ ...ownerFilter, status: "site_visit" }),
  ]);

  const [
    whatsappReplyRows,
    emailReplyRows,
    whatsappSent,
    emailSent,
    sourceFiles,
  ] = await Promise.all([
    aggregateWhatsAppReplies(queryOwnerId),
    aggregateEmailReplies(queryOwnerId),
    countSentLeads(queryOwnerId, "whatsapp"),
    countSentLeads(queryOwnerId, "email"),
    Lead.distinct("sourceFile", {
      ...ownerFilter,
      sourceFile: { $type: "string", $ne: "" },
    }),
  ]);
  const whatsappReplies = whatsappReplyRows.map((entry) => entry._id);
  const emailReplies = emailReplyRows.map((entry) => entry._id);
  const repliedIds = new Set([...whatsappReplies, ...emailReplies].map(String));

  // conversationStarted lets the frontend show a "Start" button for any lead
  // that's been imported/created but whose opening WhatsApp message hasn't
  // gone out yet (see POST /leads/start-conversations).
  const pageLeadIds = leads.map((lead) => lead._id);
  const [conversations, outboundJobs, emailEvents, whatsappMessages, visits] =
    await Promise.all([
      Conversation.find(
        { ownerId: queryOwnerId, leadId: { $in: pageLeadIds } },
        "leadId lastMessageAt",
      ).lean(),
      OutboundJob.find({ ownerId: queryOwnerId, leadId: { $in: pageLeadIds } })
        .sort({ updatedAt: -1 })
        .lean(),
      EmailMessage.find({ ownerId: queryOwnerId, leadId: { $in: pageLeadIds } })
        .sort({ createdAt: -1 })
        .lean(),
      Message.find({ leadId: { $in: pageLeadIds } })
        .sort({ timestamp: -1 })
        .lean(),
      Meeting.aggregate([
        {
          $match: {
            ownerId: asObjectId(queryOwnerId),
            leadId: { $in: pageLeadIds },
          },
        },
        { $sort: { preferredDate: -1, preferredTime: -1, updatedAt: -1 } },
        {
          $group: {
            _id: "$leadId",
            siteVisitCount: { $sum: 1 },
            latestVisit: { $first: "$$ROOT" },
          },
        },
      ]),
    ]);
  const lastMessageByLead = new Map(
    conversations.map((c) => [String(c.leadId), c.lastMessageAt]),
  );
  const outboundMessageLeadIds = new Set(
    whatsappMessages
      .filter((message) => message.direction === "outbound")
      .map((message) => String(message.leadId)),
  );
  const channelStatus = new Map();
  for (const job of outboundJobs) {
    // A pre-created/no-attempt queue row is not a real send result. Legacy
    // non-campaign failures came from the old auto-start flow; don't label a
    // never-messaged contact as failed unless an outbound record exists.
    if (job.status !== "sent" && !(Number(job.attempts || 0) > 0)) continue;
    if (
      job.channel === "whatsapp" &&
      job.status === "failed" &&
      !job.campaignId &&
      !outboundMessageLeadIds.has(String(job.leadId))
    )
      continue;
    const key = String(job.leadId);
    if (!channelStatus.has(key)) channelStatus.set(key, {});
    const state = channelStatus.get(key);
    if (!state[job.channel]) state[job.channel] = job;
  }
  const emailState = new Map();
  for (const event of emailEvents) {
    const key = String(event.leadId);
    if (!emailState.has(key))
      emailState.set(key, {
        sentAt: null,
        status: "not_sent",
        replyAt: null,
        replyCount: 0,
        subject: "",
      });
    const state = emailState.get(key);
    if (event.direction === "inbound" && event.kind === "received") {
      state.replyCount += 1;
      if (!state.replyAt) state.replyAt = event.receivedAt || event.createdAt;
    } else if (
      event.direction === "outbound" &&
      event.kind === "campaign" &&
      state.status === "not_sent"
    ) {
      state.status = event.status;
      state.sentAt = event.sentAt || null;
      state.subject = event.subject || "";
    }
  }
  const whatsappState = new Map();
  for (const message of whatsappMessages) {
    const key = String(message.leadId);
    if (!whatsappState.has(key))
      whatsappState.set(key, {
        sentAt: null,
        sentStatus: "not_sent",
        replyAt: null,
        replyCount: 0,
      });
    const state = whatsappState.get(key);
    if (message.direction === "inbound" && message.sender === "customer") {
      state.replyCount += 1;
      if (!state.replyAt)
        state.replyAt = message.timestamp || message.createdAt;
    } else if (message.direction === "outbound" && !state.sentAt) {
      state.sentAt = message.timestamp || message.createdAt;
      state.sentStatus = message.status || "sent";
    }
  }
  const visitState = new Map(visits.map((row) => [String(row._id), row]));
  const leadsWithStatus = leads.map((lead) => {
    const key = String(lead._id);
    const wa = whatsappState.get(key) || {};
    const email = emailState.get(key) || {};
    const jobs = channelStatus.get(key) || {};
    const waJob = jobs.whatsapp;
    const emailJob = jobs.email;
    const visit = visitState.get(key);
    return {
      ...lead,
      conversationStarted: Boolean(lastMessageByLead.get(key)),
      whatsappMessageStatus: waJob?.status || wa.sentStatus || "not_sent",
      whatsappSentAt: waJob?.sentAt || wa.sentAt || null,
      whatsappReplyAt: wa.replyAt || null,
      whatsappReplyCount: wa.replyCount || 0,
      emailMessageStatus: emailJob?.status || email.status || "not_sent",
      emailSentAt: emailJob?.sentAt || email.sentAt || null,
      emailReplyAt: email.replyAt || null,
      emailReplyCount: email.replyCount || 0,
      lastReplyAt:
        [wa.replyAt, email.replyAt]
          .filter(Boolean)
          .sort((a, b) => new Date(b) - new Date(a))[0] || null,
      replyReceived: Boolean(wa.replyAt || email.replyAt),
      siteVisitCount: visit?.siteVisitCount || 0,
      latestSiteVisit: visit?.latestVisit || null,
    };
  });

  return new ApiResponse(200, {
    leads: leadsWithStatus,
    summary: {
      total: allLeads,
      whatsappAvailable,
      emailAvailable,
      bothAvailable,
      whatsappOnly,
      emailOnly,
      siteVisits,
      whatsappReplies: whatsappReplies.length,
      emailReplies: emailReplies.length,
      whatsappSent,
      emailSent,
      replied: repliedIds.size,
      sourceFiles: sourceFiles
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/**
 * GET /api/leads/:id
 */
const getLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, ...scopeToOwner(req) });
  if (!lead) throw ApiError.notFound("Lead not found");
  return new ApiResponse(200, { lead }).send(res);
});

/**
 * PATCH /api/leads/:id
 */
const updateLead = asyncHandler(async (req, res) => {
  const updates = { ...req.body };
  const currentLead = await Lead.findOne({
    _id: req.params.id,
    ...scopeToOwner(req),
  });
  if (!currentLead) throw ApiError.notFound("Lead not found");
  if (Object.prototype.hasOwnProperty.call(updates, "phone")) {
    if (updates.phone && String(updates.phone).trim()) {
      try {
        updates.phone = toWhatsAppNumber(updates.phone);
      } catch (err) {
        throw ApiError.badRequest(err.message || "Enter a valid phone number");
      }
    } else updates.phone = null;
    if (updates.phone) {
      const dupe = await Lead.findOne({
        ownerId: req.user.id,
        phone: updates.phone,
        _id: { $ne: req.params.id },
      });
      if (dupe)
        throw ApiError.conflict("Another lead already uses this phone number");
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates, "email")) {
    updates.email =
      String(updates.email || "")
        .trim()
        .toLowerCase() || null;
    if (updates.email) {
      const duplicateEmail = await Lead.findOne({
        ownerId: req.user.id,
        email: updates.email,
        _id: { $ne: req.params.id },
      });
      if (duplicateEmail)
        throw ApiError.conflict("Another lead already uses this email address");
    }
  }

  const finalPhone = Object.prototype.hasOwnProperty.call(updates, "phone")
    ? updates.phone
    : currentLead.phone;
  const finalEmail = Object.prototype.hasOwnProperty.call(updates, "email")
    ? updates.email
    : currentLead.email;
  if (!String(finalPhone || "").trim() && !String(finalEmail || "").trim()) {
    throw ApiError.badRequest(
      "Lead ke paas kam se kam phone ya email rehna chahiye",
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(updates, "name") &&
    !String(updates.name || "").trim()
  ) {
    updates.name =
      (finalEmail
        ? String(finalEmail)
            .split("@")[0]
            .replace(/[._+-]+/g, " ")
            .trim()
        : `Lead ${String(finalPhone || "")
            .replace(/\D/g, "")
            .slice(-4)}`) || "New lead";
    updates.name = updates.name.slice(0, 150);
  }

  const lead = await Lead.findOneAndUpdate(
    { _id: req.params.id, ...scopeToOwner(req) },
    { $set: updates },
    { new: true, runValidators: true },
  );
  if (!lead) throw ApiError.notFound("Lead not found");

  // WhatsApp contacts gain a conversation shell when a number is added later;
  // do not enqueue unsolicited messages here—leave sending to the user/campaign.
  if (lead.phone) {
    await Conversation.updateOne(
      { ownerId: lead.ownerId, leadId: lead._id },
      { $setOnInsert: { ownerId: lead.ownerId, leadId: lead._id } },
      { upsert: true },
    );
  }

  return new ApiResponse(200, { lead }, "Lead updated").send(res);
});

/**
 * DELETE /api/leads/:id
 */
const deleteLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOneAndDelete({
    _id: req.params.id,
    ...scopeToOwner(req),
  });
  if (!lead) throw ApiError.notFound("Lead not found");

  await Conversation.deleteOne({ leadId: lead._id });

  return new ApiResponse(200, null, "Lead deleted").send(res);
});

/**
 * POST /api/leads/bulk-delete
 */
const bulkDeleteLeads = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const filter = { _id: { $in: ids }, ...scopeToOwner(req) };

  const result = await Lead.deleteMany(filter);
  await Conversation.deleteMany({ leadId: { $in: ids } });

  return new ApiResponse(
    200,
    { deletedCount: result.deletedCount },
    "Leads deleted",
  ).send(res);
});

/**
 * POST /api/leads/:id/tags   body: { add?: string[], remove?: string[] }
 */
const updateTags = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, ...scopeToOwner(req) });
  if (!lead) throw ApiError.notFound("Lead not found");

  const { add = [], remove = [] } = req.body;
  let tags = new Set(lead.tags);
  add.forEach((t) => tags.add(t));
  remove.forEach((t) => tags.delete(t));
  lead.tags = Array.from(tags);
  await lead.save();

  return new ApiResponse(200, { lead }, "Tags updated").send(res);
});

/**
 * GET /api/leads/export
 * Exports the current filtered view as a downloadable CSV (same filters as listLeads).
 */
const sampleSheet = asyncHandler(async (_req, res) => {
  const headers = ["Naam", "Mobile", "Email", "Address", "Job title"];
  const workbook = writeXlsxBuffer({
    headers,
    rows: [],
    sheetName: "Contacts",
  });
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="propai-contacts-sample.xlsx"',
  );
  return res.send(workbook);
});

/**
 * GET /api/leads/export
 * CSV remains the default for legacy clients. format=xlsx returns a real
 * Office Open XML workbook, including when exporting the Qualified Leads view.
 */
const exportLeads = asyncHandler(async (req, res) => {
  const { search, status, city, tag, format, qualifiedOnly } = req.query;
  const ownerFilter = { ...scopeToOwner(req), inCrm: { $ne: false } };
  let leads;

  if (
    String(qualifiedOnly || "") === "1" ||
    String(qualifiedOnly || "").toLowerCase() === "true"
  ) {
    const result = await getQualifiedLeadRows({
      ownerId: ownerFilter.ownerId,
      query: {
        tab: req.query.tab,
        temperature: req.query.temperature,
        sortBy: req.query.sortBy,
        search,
        replyChannel: req.query.replyChannel,
      },
    });
    leads = result.rows;
  } else {
    const filter = { ...ownerFilter };
    if (status) filter.status = status;
    if (city)
      filter.city = new RegExp(
        `^${String(city)
          .slice(0, 100)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i",
      );
    if (tag) filter.tags = tag;
    if (req.query.sourceFile) {
      if (req.query.sourceFile === "manual")
        filter.$and = [
          {
            $or: [{ sourceType: "manual" }, { sourceType: { $exists: false } }],
          },
        ];
      else filter.sourceFile = req.query.sourceFile;
    }
    if (search) {
      const escaped = String(search)
        .trim()
        .slice(0, 120)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (escaped) {
        const re = new RegExp(escaped, "i");
        filter.$or = [
          { name: re },
          { email: re },
          { phone: re },
          { city: re },
          { address: re },
          { occupation: re },
          { notes: re },
          { requirements: re },
        ];
      }
    }
    leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();
  }

  if (String(format || "").toLowerCase() === "xlsx") {
    const qualified =
      String(qualifiedOnly || "") === "1" ||
      String(qualifiedOnly || "").toLowerCase() === "true";
    const headers = qualified
      ? [
          "Name",
          "Mobile / WhatsApp",
          "Email",
          "WhatsApp Sent",
          "WhatsApp Reply",
          "Email Sent",
          "Lead Temperature",
          "Score",
          "Address",
          "Job Title",
        ]
      : [
          "Naam",
          "Mobile",
          "Email",
          "Address",
          "Job title",
          "City",
          "Location",
          "Budget min",
          "Budget max",
          "Source type",
          "Source file",
          "Status",
          "Lead score",
          "Tags",
          "Created at",
        ];
    const rows = leads.map((lead) =>
      qualified
        ? {
            Name: lead.name || "",
            "Mobile / WhatsApp": lead.phone || "",
            Email: lead.email || "",
            "WhatsApp Sent": lead.whatsappSentAt ? "Yes" : "No",
            "WhatsApp Reply": lead.whatsappReplyAt
              ? "Yes"
              : lead.hasWhatsAppReply
                ? "Yes"
                : "No",
            "Email Sent": lead.emailSentAt ? "Yes" : "No",
            "Lead Temperature":
              Number(lead.leadScore || 0) > 60
                ? "Hot"
                : Number(lead.leadScore || 0) > 30
                  ? "Warm"
                  : "Cold",
            Score: lead.leadScore ?? 0,
            Address: lead.address || "",
            "Job Title": lead.occupation || "",
          }
        : {
            Naam: lead.name || "",
            Mobile: lead.phone || "",
            Email: lead.email || "",
            Address: lead.address || "",
            "Job title": lead.occupation || "",
            City: lead.city || "",
            Location: lead.location || "",
            "Budget min": lead.budgetMin ?? "",
            "Budget max": lead.budgetMax ?? "",
            "Source type": lead.sourceType || "manual",
            "Source file": lead.sourceFile || "",
            Status: lead.status || "",
            "Lead score": lead.leadScore ?? 0,
            Tags: (lead.tags || []).join("|"),
            "Created at": lead.createdAt || "",
          },
    );
    const workbook = writeXlsxBuffer({
      headers,
      rows,
      sheetName: qualified ? "Qualified Leads" : "Contacts",
    });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${qualified ? "qualified-leads" : "leads-export"}-${Date.now()}.xlsx"`,
    );
    return res.send(workbook);
  }

  const fields = [
    "name",
    "phone",
    "email",
    "address",
    "city",
    "location",
    "occupation",
    "sourceType",
    "sourceFile",
    "budgetMin",
    "budgetMax",
    "age",
    "source",
    "status",
    "leadScore",
    "tags",
    "notes",
    "requirements",
    "createdAt",
  ];
  const parser = new CsvParser({ fields });
  const csv = parser.parse(
    leads.map((lead) => ({ ...lead, tags: (lead.tags || []).join("|") })),
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="leads-export-${Date.now()}.csv"`,
  );
  return res.send(csv);
});

module.exports = {
  previewImport,
  previewText,
  confirmImport,
  startConversations,
  createLead,
  listLeads,
  getLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  updateTags,
  exportLeads,
  sampleSheet,
};
