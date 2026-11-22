const { Parser: CsvParser } = require("json2csv");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Lead = require("../models/Lead");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const EmailMessage = require("../models/EmailMessage");
const OutboundJob = require("../models/OutboundJob");
const contacted = require("../services/queue/contactedContacts");
const {
  summarizeWhatsappMessages,
} = require("../services/whatsapp/messageSummary");
const Meeting = require("../models/Meeting");
const AuditLog = require("../models/AuditLog");
const {
  parseLeadFile,
  parseLeadText,
  analyzeRows,
} = require("../services/csv/leadImporter");
const { importLeadRows } = require("../services/leads/leadImportService");
const { toWhatsAppNumber } = require("../services/whatsapp/metaWhatsappClient");
const { enqueueLeads } = require("../services/queue/outboundQueue");

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

const { LEAD_SCORE, HOT_SCORE, leadTypeFor } = require("../config/leadRules");

const AUTO_REPLY_PATTERN =
  /(automatic reply|auto.?reply|out of office|do not reply|no.?reply|i am an ai|virtual assistant|leave a message|not monitored|on leave until)/i;

/**
 * Who has genuinely replied, and who has a site visit. A human-looking reply
 * counts at once; if every message looks like an auto-responder it only
 * counts after 3 of them (so an out-of-office mail is not a buyer).
 */
async function getQualificationSets(req, replyChannel = "") {
  const ownerFilter = scopeToOwner(req);
  const ownedIds = await Lead.find(ownerFilter).distinct("_id");
  const owned = new Set(ownedIds.map(String));
  const repliedIds = new Set();

  if (replyChannel !== "whatsapp") {
    // Only count genuine inbound email replies. Exclude automated replies using
    // the same policy as WhatsApp, so out-of-office messages do not qualify a lead.
    const emailReplies = await EmailMessage.find({
      ...ownerFilter,
      direction: "inbound",
      kind: "received",
      leadId: { $ne: null },
    })
      .select("leadId subject text")
      .lean();
    const groupedEmail = new Map();
    for (const email of emailReplies) {
      if (!email.leadId || !owned.has(String(email.leadId))) continue;
      const id = String(email.leadId);
      if (!groupedEmail.has(id)) groupedEmail.set(id, { human: 0, auto: 0 });
      const group = groupedEmail.get(id);
      const content = `${email.subject || ""} ${email.text || ""}`;
      if (AUTO_REPLY_PATTERN.test(content)) group.auto += 1;
      else group.human += 1;
    }
    for (const [id, group] of groupedEmail) {
      if (group.human >= 1 || group.auto >= 3) repliedIds.add(id);
    }
  }
  if (replyChannel !== "email") {
    const inbound = await Message.find({
      leadId: { $in: ownedIds },
      direction: "inbound",
      sender: "customer",
    })
      .select("leadId text")
      .lean();
    const grouped = new Map();
    for (const message of inbound) {
      const key = String(message.leadId);
      if (!grouped.has(key)) grouped.set(key, { human: 0, auto: 0 });
      const item = grouped.get(key);
      if (AUTO_REPLY_PATTERN.test(message.text || "")) item.auto += 1;
      else item.human += 1;
    }
    for (const [id, item] of grouped)
      if (item.human >= 1 || item.auto >= 3) repliedIds.add(id);
  }

  const meetingOwner = ownerFilter.ownerId;
  const visitLeadIds = await Meeting.distinct("leadId", {
    ownerId: meetingOwner,
    status: { $ne: "cancelled" },
  });
  const visitIds = new Set(
    visitLeadIds.map(String).filter((id) => owned.has(id)),
  );
  return { repliedIds: [...repliedIds], visitIds: [...visitIds] };
}

function buildStageClause(stage, { repliedIds, visitIds, replyChannel }) {
  const replied = { _id: { $in: repliedIds } };
  const visit = { $or: [{ _id: { $in: visitIds } }, { status: "site_visit" }] };
  // A channel view (WhatsApp → Leads) only shows people who replied on that channel.
  const channelGuard = replyChannel ? [replied] : [];
  if (stage === "hot")
    return { $and: [replied, { leadScore: { $gt: HOT_SCORE } }] };
  if (stage === "visit") return { $and: [visit, ...channelGuard] };
  // The "all" tab and channel-specific Leads pages show every genuine reply,
  // even while AI scoring is low or still running. The score remains useful for
  // classification; Hot and Visit tabs retain their stricter rules.
  return { $and: [{ $or: [replied, visit] }, ...channelGuard] };
}

/**
 * POST /api/leads/import/preview
 * Upload a CSV, get back every row annotated as valid/invalid/duplicate.
 * Nothing is written to the DB at this step.
 */
const previewImport = asyncHandler(async (req, res) => {
  if (!req.file)
    throw ApiError.badRequest('CSV file is required (field name: "file")');

  let rows;
  try {
    rows = parseLeadFile(req.file.buffer, req.file.originalname);
  } catch (err) {
    throw ApiError.badRequest(err.message);
  }

  const { rows: analyzed, summary } = await analyzeRows(req.user.id, rows);

  return new ApiResponse(200, { rows: analyzed, summary }, "CSV parsed").send(
    res,
  );
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
  const { rows } = req.body;
  const ownerId = req.user.id;

  const {
    inserted,
    skipped,
    invalid = 0,
    existingIds = [],
  } = await importLeadRows(ownerId, rows);

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
      invalid,
      leadIds: inserted.map((lead) => lead._id),
      existingLeadIds: existingIds,
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

  // Ek request me max START_MAX_PER_REQUEST (default 100) leads. Bulk ke liye
  // campaign use karna hai (daily limit, pause/resume, retry sab wahin hai).
  const maxPerRequest = (() => {
    const n = Number(process.env.START_MAX_PER_REQUEST);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
  })();
  const uniqueLeadIds = [...new Set(leadIds.map(String))];
  if (uniqueLeadIds.length > maxPerRequest) {
    throw ApiError.badRequest(
      `Ek baar me max ${maxPerRequest} leads start ho sakte hain (aapne ${uniqueLeadIds.length} chune). Zyada leads ke liye WhatsApp campaign use karein.`,
    );
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
      requested: uniqueLeadIds.length,
      count: queueResult.queued,
      queued: queueResult.queued,
      skipped: queueResult.skipped,
      healthSkipped: queueResult.healthSkipped || 0,
      maxPerRequest,
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
    dateFrom,
    dateTo,
    reply,
    temperature,
  } = req.query;

  const filter = { ...scopeToOwner(req) };
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
    if (channel === "whatsapp" && delivery === "unsent") {
      // Naye campaign ke liye "bhejne layak" contacts: jinko pehle message ja chuka
      // hai, jinka send fail hua (retry-later / cannot-send), aur jo kisi campaign
      // ki queue me pade hain — sab chhupao. Unki list /api/campaigns/contacted me hai.
      const flag = (v) => ["1", "true"].includes(String(v || ""));
      const hiddenLeadIds = await contacted.getHiddenLeadIds(req.user.id, {
        showSent: flag(req.query.showSent),
        showFailed: flag(req.query.showFailed),
      });
      idClauses.push({ _id: { $nin: hiddenLeadIds } });
    } else {
      const sentLeadIds = await OutboundJob.distinct("leadId", {
        ownerId: req.user.id,
        channel,
        status: "sent",
      });
      idClauses.push({
        _id: delivery === "sent" ? { $in: sentLeadIds } : { $nin: sentLeadIds },
      });
    }
  }

  // Audience / explicit selection: ?ids=a,b,c (used by bulk messaging to show
  // an audience's contacts). Only well-formed ids are accepted.
  if (req.query.ids) {
    const ids = String(req.query.ids)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
    idClauses.push({ _id: { $in: ids } });
  }

  // Upload Data filters: date range (IST days), reply / not replied, and
  // hot / warm / cold. Same rules as Qualified Leads (see config/leadRules.js):
  //   hot  = replied + score > HOT_SCORE
  //   warm = replied + score > LEAD_SCORE and <= HOT_SCORE
  //   cold = everyone else (no reply, or score <= LEAD_SCORE)
  const IST_OFFSET = "+05:30";
  const dayStart = (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
      ? new Date(`${value}T00:00:00.000${IST_OFFSET}`)
      : null;
  const from = dayStart(dateFrom);
  const to = dayStart(dateTo);
  if (from || to) {
    const range = {};
    if (from && !Number.isNaN(from.getTime())) range.$gte = from;
    if (to && !Number.isNaN(to.getTime()))
      range.$lt = new Date(to.getTime() + 24 * 60 * 60 * 1000);
    if (Object.keys(range).length) idClauses.push({ createdAt: range });
  }
  const replyFilter = ["replied", "not_replied"].includes(String(reply || ""))
    ? String(reply)
    : "";
  const tempFilter = ["hot", "warm", "cold"].includes(String(temperature || ""))
    ? String(temperature)
    : "";
  if (replyFilter || tempFilter) {
    const { repliedIds: replySet } = await getQualificationSets(
      req,
      ["whatsapp", "email"].includes(String(req.query.replyChannel || ""))
        ? String(req.query.replyChannel)
        : "",
    );
    const replied = { _id: { $in: replySet } };
    const notReplied = { _id: { $nin: replySet } };
    if (replyFilter === "replied") idClauses.push(replied);
    if (replyFilter === "not_replied") idClauses.push(notReplied);
    if (tempFilter === "hot")
      idClauses.push({ $and: [replied, { leadScore: { $gt: HOT_SCORE } }] });
    if (tempFilter === "warm")
      idClauses.push({
        $and: [
          replied,
          { leadScore: { $gt: LEAD_SCORE, $lte: HOT_SCORE } },
        ],
      });
    if (tempFilter === "cold")
      idClauses.push({
        $or: [notReplied, { leadScore: { $not: { $gt: LEAD_SCORE } } }],
      });
  }

  // Qualified Leads (and WhatsApp → Leads / Email → Leads):
  //   all   = any genuine customer reply (any score), or a booked site visit
  //   hot   = replied + score > 60
  //   visit = site visit booked (AI on WhatsApp, or added by the broker)
  const replyChannel = ["whatsapp", "email"].includes(
    String(req.query.replyChannel || ""),
  )
    ? String(req.query.replyChannel)
    : "";
  let qualifiedCounts = null;
  if (
    String(qualifiedOnly || "") === "1" ||
    String(qualifiedOnly || "").toLowerCase() === "true"
  ) {
    const { repliedIds, visitIds } = await getQualificationSets(
      req,
      replyChannel,
    );
    const stageClause = (name) =>
      buildStageClause(name, { repliedIds, visitIds, replyChannel });
    idClauses.push(
      stageClause(
        ["hot", "visit"].includes(req.query.stage) ? req.query.stage : "all",
      ),
    );
    const ownerOnly = scopeToOwner(req);
    const [all, hot, visit] = await Promise.all([
      Lead.countDocuments({ ...ownerOnly, ...stageClause("all") }),
      Lead.countDocuments({ ...ownerOnly, ...stageClause("hot") }),
      Lead.countDocuments({ ...ownerOnly, ...stageClause("visit") }),
    ]);
    qualifiedCounts = {
      all,
      hot,
      visit,
      leadScore: LEAD_SCORE,
      hotScore: HOT_SCORE,
    };
  }
  if (idClauses.length) filter.$and = [...(filter.$and || []), ...idClauses];
  if (city) filter.city = new RegExp(`^${city}$`, "i");
  if (tag) filter.tags = tag;
  if (req.query.file) {
    const fileClause = buildImportFileClause(String(req.query.file));
    if (fileClause) filter.$and = [...(filter.$and || []), fileClause];
  }
  if (search) {
    // Har word kisi na kisi field me milna chahiye ("rahul noida" = name me
    // rahul + address me noida). Phone me spaces / +91 / dashes ignore hote hain.
    const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const words = String(search)
      .trim()
      .slice(0, 120)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6);
    const wordClauses = words.map((word) => {
      const re = new RegExp(escapeRe(word), "i");
      const digits = word.replace(/\D/g, "");
      const fields = [
        { name: re },
        { email: re },
        { phone: re },
        { city: re },
        { address: re },
        { jobTitle: re },
        { notes: re },
        { requirements: re },
      ];
      if (digits.length >= 3 && digits !== word)
        fields.push({ phone: new RegExp(escapeRe(digits)) });
      return { $or: fields };
    });
    if (wordClauses.length)
      filter.$and = [...(filter.$and || []), ...wordClauses];
  }

  // _id as a tie-breaker keeps the order (and so the Sr. no.) stable between pages.
  const sort = {
    [sortBy]: sortOrder === "asc" ? 1 : -1,
    _id: sortOrder === "asc" ? 1 : -1,
  };

  // Contacts sheet: ordered ids only, for "select Sr. no. X to Y" across pages.
  if (["1", "true"].includes(String(req.query.idsOnly || ""))) {
    const rows = await Lead.find(filter)
      .sort(sort)
      .limit(20000)
      .select("_id")
      .lean();
    return new ApiResponse(200, {
      ids: rows.map((row) => row._id),
      total: rows.length,
    }).send(res);
  }

  const ownerFilter = scopeToOwner(req);
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

  const allOwnedLeadIds = await Lead.find(ownerFilter).distinct("_id");
  const [whatsappReplies, emailReplies] = await Promise.all([
    Message.distinct("leadId", {
      leadId: { $in: allOwnedLeadIds },
      direction: "inbound",
      sender: "customer",
    }),
    EmailMessage.distinct("leadId", {
      ...ownerFilter,
      leadId: { $ne: null },
      direction: "inbound",
      kind: "received",
    }),
  ]);

  // conversationStarted lets the frontend show a "Start" button for any lead
  // that's been imported/created but whose opening WhatsApp message hasn't
  // gone out yet (see POST /leads/start-conversations).
  const pageLeadIds = leads.map((lead) => lead._id);
  const [conversations, outboundJobs, emailEvents, waSummary, visits] =
    await Promise.all([
      Conversation.find(
        { ownerId: req.user.id, leadId: { $in: pageLeadIds } },
        "leadId lastMessageAt",
      ).lean(),
      OutboundJob.find({ ownerId: req.user.id, leadId: { $in: pageLeadIds } })
        .sort({ updatedAt: -1 })
        .lean(),
      EmailMessage.find({ ownerId: req.user.id, leadId: { $in: pageLeadIds } })
        .sort({ createdAt: -1 })
        .lean(),
      // DB me group hota hai (pehle saare messages memory me sort hote the -> 32MB limit error)
      summarizeWhatsappMessages(pageLeadIds),
      Meeting.aggregate([
        {
          $match: {
            ownerId: req.user._id || req.user.id,
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
  const outboundMessageLeadIds = waSummary.outboundLeadIds;
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
  const whatsappState = waSummary.byLead;
  const visitState = new Map(visits.map((row) => [String(row._id), row]));
  // Contacts picker ke liye: har row ka asli WhatsApp state (hide-filter wahi rule
  // use karta hai), taaki \"Nahi bheja\" dikha kar fail/queue wale contacts na chhupein.
  let contactedState = null;
  if (channel === "whatsapp") {
    try {
      contactedState = await contacted.getContactedState(req.user.id);
    } catch {
      contactedState = null;
    }
  }
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
      whatsappContactState: contactedState
        ? contactedState.byLead.get(key)?.group ||
          (contactedState.queuedIds.has(key) ? "queued" : null)
        : undefined,
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
      leadType: leadTypeFor({
        score: lead.leadScore,
        hasVisit:
          Boolean(visit?.siteVisitCount) || lead.status === "site_visit",
        replied: Boolean(wa.replyAt || email.replyAt),
      }),
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
      repliedContacts: new Set(
        [...whatsappReplies, ...emailReplies].map(String),
      ).size,
      qualified: qualifiedCounts,
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/**
 * Upload Data → sheet-wise view.
 *
 * Sheet key:
 *   "<file name>"                  → importFile / importFiles me ye naam
 *   "__batch__:<fromMs>:<toMs>"    → purane uploads jinka sheet naam save nahi
 *                                    hua tha (schema bug) — upload time se group
 *   "__manual__"                   → manually add / WhatsApp inbound / baaki
 */
const UPLOAD_SOURCE_RE = /^(file_import|bulk_sheet_upload|csv_import)/;
const LEGACY_BATCH_GAP_MS = 10 * 60 * 1000;
const noImportFile = {
  $and: [
    {
      $or: [
        { importFile: null },
        { importFile: "" },
        { importFile: { $exists: false } },
      ],
    },
    {
      $or: [{ importFiles: { $exists: false } }, { importFiles: { $size: 0 } }],
    },
  ],
};

function buildImportFileClause(file) {
  if (file === "__manual__") {
    return { $and: [noImportFile, { source: { $not: UPLOAD_SOURCE_RE } }] };
  }
  const batch = /^__batch__:(\d+):(\d+)$/.exec(file);
  if (batch) {
    return {
      $and: [
        noImportFile,
        { source: UPLOAD_SOURCE_RE },
        {
          createdAt: {
            $gte: new Date(Number(batch[1])),
            $lte: new Date(Number(batch[2])),
          },
        },
      ],
    };
  }
  return { $or: [{ importFile: file }, { importFiles: file }] };
}

/**
 * GET /api/leads/import-files — the sheets contacts were uploaded from, newest first.
 */
const listImportFiles = asyncHandler(async (req, res) => {
  const ownerFilter = scopeToOwner(req);
  const ownerId = new (require("mongoose").Types.ObjectId)(
    String(ownerFilter.ownerId),
  );
  const hasLen = (field) => ({
    $cond: [{ $gt: [{ $strLenCP: { $ifNull: [field, ""] } }, 0] }, 1, 0],
  });

  // 1) Naam wali sheets (importFile + importFiles dono se)
  const named = await Lead.aggregate([
    { $match: { ownerId } },
    {
      $project: {
        phone: 1,
        email: 1,
        createdAt: 1,
        files: {
          $setUnion: [
            { $ifNull: ["$importFiles", []] },
            {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ["$importFile", ""] } }, 0] },
                ["$importFile"],
                [],
              ],
            },
          ],
        },
      },
    },
    { $unwind: "$files" },
    {
      $group: {
        _id: "$files",
        count: { $sum: 1 },
        whatsapp: { $sum: hasLen("$phone") },
        email: { $sum: hasLen("$email") },
        lastAt: { $max: "$createdAt" },
      },
    },
  ]);

  // 2) Bina naam wale leads: upload source wale ko upload-time ke gap se group
  //    karo, baaki "Manually added" me.
  const unnamed = await Lead.find({ ownerId, ...noImportFile })
    .select("source createdAt phone email")
    .sort({ createdAt: 1 })
    .lean();
  const batches = [];
  const manual = { count: 0, whatsapp: 0, email: 0, lastAt: null };
  let current = null;
  for (const lead of unnamed) {
    const at = new Date(lead.createdAt).getTime();
    const wa = lead.phone ? 1 : 0;
    const em = lead.email ? 1 : 0;
    if (!UPLOAD_SOURCE_RE.test(String(lead.source || ""))) {
      manual.count += 1;
      manual.whatsapp += wa;
      manual.email += em;
      manual.lastAt = lead.createdAt;
      continue;
    }
    if (!current || at - current.to > LEGACY_BATCH_GAP_MS) {
      current = { from: at, to: at, count: 0, whatsapp: 0, email: 0 };
      batches.push(current);
    }
    current.to = at;
    current.count += 1;
    current.whatsapp += wa;
    current.email += em;
  }

  const fmt = (ms) =>
    new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));

  const files = [
    ...named.map((row) => ({
      file: row._id,
      label: row._id,
      kind: "sheet",
      count: row.count,
      whatsapp: row.whatsapp,
      email: row.email,
      lastAt: row.lastAt,
    })),
    ...batches.map((b) => ({
      file: `__batch__:${b.from}:${b.to}`,
      label: `Sheet upload · ${fmt(b.from)}`,
      kind: "legacy",
      count: b.count,
      whatsapp: b.whatsapp,
      email: b.email,
      lastAt: new Date(b.to),
    })),
  ].sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  if (manual.count) {
    files.push({
      file: "__manual__",
      label: "Manually added / WhatsApp inbound",
      kind: "manual",
      count: manual.count,
      whatsapp: manual.whatsapp,
      email: manual.email,
      lastAt: manual.lastAt,
    });
  }
  return new ApiResponse(200, { files }).send(res);
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

  // Remove campaign tracker rows for this contact as well. The lead itself is
  // already deleted above; cleanup is owner-scoped wherever the model supports it.
  await Promise.all([
    Conversation.deleteMany({ ownerId: lead.ownerId, leadId: lead._id }),
    OutboundJob.deleteMany({ ownerId: lead.ownerId, leadId: lead._id }),
    EmailMessage.deleteMany({ ownerId: lead.ownerId, leadId: lead._id }),
    Message.deleteMany({ leadId: lead._id }),
  ]);

  return new ApiResponse(
    200,
    null,
    "Contact and related campaign rows deleted",
  ).send(res);
});

/**
 * POST /api/leads/bulk-delete
 */
const bulkDeleteLeads = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const filter = { _id: { $in: ids }, ...scopeToOwner(req) };
  const leads = await Lead.find(filter).select("_id ownerId").lean();
  const leadIds = leads.map((lead) => lead._id);
  if (!leadIds.length) {
    return new ApiResponse(
      200,
      { deletedCount: 0 },
      "No matching contacts found",
    ).send(res);
  }

  const result = await Lead.deleteMany({
    _id: { $in: leadIds },
    ...scopeToOwner(req),
  });
  const ownerIds = [...new Set(leads.map((lead) => String(lead.ownerId)))];
  await Promise.all([
    Conversation.deleteMany({ leadId: { $in: leadIds } }),
    Message.deleteMany({ leadId: { $in: leadIds } }),
    OutboundJob.deleteMany({
      leadId: { $in: leadIds },
      ownerId: { $in: ownerIds },
    }),
    EmailMessage.deleteMany({
      leadId: { $in: leadIds },
      ownerId: { $in: ownerIds },
    }),
  ]);

  return new ApiResponse(
    200,
    { deletedCount: result.deletedCount },
    "Contacts and related campaign rows deleted",
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
const exportLeads = asyncHandler(async (req, res) => {
  const { search, status, city, tag } = req.query;
  const filter = { ...scopeToOwner(req) };
  if (status) filter.status = status;
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
      ];
    }
  }

  const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();

  const fields = [
    "name",
    "phone",
    "email",
    "city",
    "location",
    "address",
    "jobTitle",
    "budgetMin",
    "budgetMax",
    "occupation",
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
    leads.map((l) => ({ ...l, tags: (l.tags || []).join("|") })),
  );

  res.setHeader("Content-Type", "text/csv");
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
  listImportFiles,
  getLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  updateTags,
  exportLeads,
};
