const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Conversation = require("../models/Conversation");
const Lead = require("../models/Lead");
const Message = require("../models/Message");
const LeadScore = require("../models/LeadScore");
const FollowUp = require("../models/FollowUp");
const Meeting = require("../models/Meeting");
const metaWhatsappClient = require("../services/whatsapp/metaWhatsappClient");
const { recordOutboundMessage } = require("../services/whatsapp/messageStore");
const { emitToUser } = require("../sockets");

/** Brokers see only their own conversations; admins may pass ?ownerId= to inspect a specific broker. */
function scopeOwnerId(req) {
  if (req.user.role === "admin" && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

/**
 * GET /api/conversations
 * Supports the left-hand filter rail from the spec: unread, hot, warm, cold,
 * site_visit, closed, lost — plus free-text search on the lead's name/phone.
 */
const listConversations = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { filter, search, page, limit, leadId, date, activity } = req.query;

  const leadFilter = { ownerId };
  if (leadId) leadFilter._id = leadId; // open a lead's chat straight from Leads / Follow Ups
  if (
    ["hot", "warm", "cold", "closed", "lost", "site_visit"].includes(filter)
  ) {
    leadFilter.status = filter;
  }
  if (search) {
    const escaped = String(search)
      .trim()
      .slice(0, 120)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    leadFilter.$or = [
      { name: new RegExp(escaped, "i") },
      { phone: new RegExp(escaped, "i") },
    ];
  }

  const leadIds = await Lead.find(leadFilter).distinct("_id");

  // Imported contacts may have an empty Conversation shell for future sends.
  // Only show a thread after a real inbound message or a successfully sent outbound message exists.
  const inboundClause = { direction: "inbound", sender: "customer" };
  const outboundClause = {
    direction: "outbound",
    status: { $in: ["sent", "delivered", "read"] },
  };

  // Date filter (IST din): us din ke sent / reply messages wale chats
  let dayRange = null;
  if (date) {
    const start = new Date(`${date}T00:00:00.000+05:30`);
    if (!Number.isNaN(start.getTime()))
      dayRange = { $gte: start, $lt: new Date(start.getTime() + 86400000) };
  }
  const clauses =
    activity === "sent"
      ? [outboundClause]
      : activity === "replied"
        ? [inboundClause]
        : [inboundClause, outboundClause];
  const activeConversationIds = await Message.distinct("conversationId", {
    $or: dayRange
      ? clauses.map((c) => ({ ...c, timestamp: dayRange }))
      : clauses,
  });
  const convFilter = {
    ownerId,
    leadId: { $in: leadIds },
    _id: { $in: activeConversationIds },
  };
  if (filter === "unread") convFilter.unreadCount = { $gt: 0 };

  const [conversations, total] = await Promise.all([
    Conversation.find(convFilter)
      .populate("leadId", "name phone city status leadScore source")
      .populate("recommendedProperties", "projectName city bhk")
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Conversation.countDocuments(convFilter),
  ]);

  // Date filter ho to har chat ke liye us din kitne sent / reply gaye (list me badge)
  if (dayRange && conversations.length) {
    const rows = await Message.aggregate([
      {
        $match: {
          conversationId: { $in: conversations.map((c) => c._id) },
          timestamp: dayRange,
          $or: [inboundClause, outboundClause],
        },
      },
      { $group: { _id: { c: "$conversationId", d: "$direction" }, n: { $sum: 1 } } },
    ]);
    const byConv = new Map();
    for (const r of rows) {
      const cur = byConv.get(String(r._id.c)) || { sent: 0, replied: 0 };
      if (r._id.d === "outbound") cur.sent = r.n;
      else cur.replied = r.n;
      byConv.set(String(r._id.c), cur);
    }
    for (const c of conversations)
      c.dayStats = byConv.get(String(c._id)) || { sent: 0, replied: 0 };
  }

  // WhatsApp jaisa list: har chat ka last message (text, tick status, time)
  const pageConvIds = conversations.map((c) => c._id);
  const lastRows = pageConvIds.length
    ? await Message.aggregate([
        { $match: { conversationId: { $in: pageConvIds } } },
        { $sort: { conversationId: 1, timestamp: -1 } },
        {
          $group: {
            _id: "$conversationId",
            text: { $first: "$text" },
            sender: { $first: "$sender" },
            direction: { $first: "$direction" },
            status: { $first: "$status" },
            timestamp: { $first: "$timestamp" },
          },
        },
      ])
    : [];
  const lastById = new Map(lastRows.map((r) => [String(r._id), r]));
  for (const c of conversations) {
    const last = lastById.get(String(c._id));
    c.lastMessage = last
      ? {
          text: String(last.text || "").slice(0, 140),
          sender: last.sender,
          direction: last.direction,
          status: last.status,
          timestamp: last.timestamp,
        }
      : null;
  }

  return new ApiResponse(200, {
    conversations,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/**
 * GET /api/conversations/:id
 * Full thread for the right-hand panel: lead profile, AI summary, score,
 * recommended properties, meeting status, and paginated message history.
 */
const getConversation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { page = 1, limit = 50, before } = req.query;

  const conversation = await Conversation.findOne({
    _id: req.params.id,
    ownerId,
  })
    .populate("leadId")
    .populate("recommendedProperties");
  if (!conversation) throw ApiError.notFound("Conversation not found");

  // ?before=<ISO time> → us time se pehle ke messages (chat me upar scroll
  // karke purane messages load karne ke liye). Warna latest page.
  const beforeDate = before ? new Date(before) : null;
  const msgFilter = { conversationId: conversation._id };
  if (beforeDate && !Number.isNaN(beforeDate.getTime()))
    msgFilter.timestamp = { $lt: beforeDate };
  const [messages, messageCount, olderCount] = await Promise.all([
    Message.find(msgFilter)
      .sort({ timestamp: -1 })
      .skip(beforeDate ? 0 : (page - 1) * limit)
      .limit(Number(limit))
      .lean(),
    Message.countDocuments({ conversationId: conversation._id }),
    Message.countDocuments(msgFilter),
  ]);
  messages.reverse(); // oldest -> newest for chat UI rendering

  // Right-hand "summary" panel: latest score reason, next follow-up, site visits.
  const leadObjectId = conversation.leadId?._id || conversation.leadId;
  const [latestScore, followUp, meetings] = await Promise.all([
    LeadScore.findOne({ leadId: leadObjectId }).sort({ createdAt: -1 }).lean(),
    FollowUp.findOne({ leadId: leadObjectId, status: "pending" })
      .sort({ nextFollowUpDate: 1 })
      .lean(),
    Meeting.find({ leadId: leadObjectId, status: { $ne: "cancelled" } })
      .populate("propertyId", "projectName city")
      .sort({ preferredDate: -1, preferredTime: -1 })
      .limit(5)
      .lean(),
  ]);

  return new ApiResponse(200, {
    conversation,
    messages,
    insights: { latestScore, followUp, meetings },
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total: messageCount,
      // Is batch se pehle aur kitne messages bache hain
      hasMore: olderCount > messages.length,
    },
  }).send(res);
});

/**
 * POST /api/conversations/:id/messages
 * Broker sends a message by hand. Does NOT change conversation.status —
 * a broker can drop into a live AI conversation for one message without
 * permanently taking it over (use /takeover for that).
 */
const sendManualReply = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { text } = req.body;

  const conversation = await Conversation.findOne({
    _id: req.params.id,
    ownerId,
  }).populate("leadId");
  if (!conversation) throw ApiError.notFound("Conversation not found");
  if (!conversation.leadId)
    throw ApiError.badRequest("This conversation has no associated lead");

  const settingsService = require("../services/settings/settingsService");
  const settings = await settingsService.getOrCreateSettings();
  if (settings.whatsappDisconnected) {
    throw ApiError.badRequest(
      "WhatsApp is disconnected — reconnect it from Settings first",
    );
  }

  // Free-text is only allowed while the WhatsApp 24h customer-service
  // window is open. That window starts from the lead's last inbound message,
  // not from our last outbound message.
  const lastInboundAt = conversation.lastInboundAt
    ? new Date(conversation.lastInboundAt).getTime()
    : 0;
  const within24Hours =
    lastInboundAt > 0 && Date.now() - lastInboundAt < 24 * 60 * 60 * 1000;

  if (!within24Hours) {
    throw ApiError.badRequest(
      "WHATSAPP_24H_WINDOW_CLOSED: The lead has not messaged this WhatsApp number within the last 24 hours. Send an approved WhatsApp template first.",
    );
  }

  const { messageId } = await metaWhatsappClient.sendTextMessage({
    phone: conversation.leadId.phone,
    text,
  });

  const message = await recordOutboundMessage({
    conversationId: conversation._id,
    leadId: conversation.leadId._id,
    text,
    sender: "broker",
    whatsappMessageId: messageId || null,
  });

  emitToUser(ownerId, "conversation:newMessage", {
    conversationId: conversation._id,
    leadId: conversation.leadId._id,
    message,
  });

  return new ApiResponse(201, { message }, "Message sent").send(res);
});

/**
 * POST /api/conversations/:id/send-template
 * 24h window band hone par chat screen se approved template bhejna (window
 * dobara khulti hai jab customer reply karta hai). Sirf broker ke click par.
 */
const sendTemplate = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const {
    templateName,
    language,
    category = "",
    headerImageUrl = "",
    variables = [],
    body = "",
    header = "",
    footer = "",
    buttons = [],
  } = req.body;

  const conversation = await Conversation.findOne({
    _id: req.params.id,
    ownerId,
  }).populate("leadId");
  if (!conversation) throw ApiError.notFound("Conversation not found");
  const lead = conversation.leadId;
  if (!lead?.phone)
    throw ApiError.badRequest("Is contact ka WhatsApp number nahi hai");

  const settingsService = require("../services/settings/settingsService");
  const settings = await settingsService.getOrCreateSettings();
  if (settings.whatsappDisconnected) {
    throw ApiError.badRequest(
      "WhatsApp is disconnected — reconnect it from Settings first",
    );
  }

  // Invalid number / marketing opt-out / 131049 cooldown wale ko mat bhejo
  const { getWhatsAppBlock } = require("../services/whatsapp/deliveryHealth");
  const block = getWhatsAppBlock(lead, category);
  if (block) throw ApiError.badRequest(block.reason);

  const maxIndex = variables.reduce(
    (max, item) => Math.max(max, Number(item.index) || 0),
    0,
  );
  const parameters = [];
  for (let index = 1; index <= maxIndex; index += 1) {
    const variable = variables.find((item) => Number(item.index) === index);
    let value = "";
    if (variable?.source === "name") value = lead.name || "";
    else if (variable?.source === "phone") value = lead.phone || "";
    else if (variable?.source === "email") value = lead.email || "";
    else value = variable?.value || "";
    parameters.push({
      type: "text",
      text: String(value || "Customer").slice(0, 1024),
    });
  }
  const components = [];
  if (headerImageUrl) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { link: headerImageUrl } }],
    });
  }
  if (parameters.length) components.push({ type: "body", parameters });

  let messageId;
  try {
    ({ messageId } = await metaWhatsappClient.sendTemplateMessage({
      phone: lead.phone,
      templateName,
      languageCode: language || "en_US",
      components,
    }));
  } catch (err) {
    throw ApiError.badRequest(
      `Template send nahi hua: ${err.metaError?.message || err.message}`,
    );
  }

  const fillVars = (text) =>
    String(text || "").replace(
      /\{\{\s*(\d+)\s*\}\}/g,
      (_m, n) => parameters[Number(n) - 1]?.text || "",
    );
  const bodyText = fillVars(body).trim();
  const preview = bodyText
    ? [
        header ? `*${fillVars(header).trim()}*` : "",
        bodyText,
        footer ? `_${String(footer).trim()}_` : "",
        (buttons || [])
          .filter(Boolean)
          .map((label) => `[ ${label} ]`)
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n")
    : `[Template: ${templateName}]`;

  const message = await recordOutboundMessage({
    conversationId: conversation._id,
    leadId: lead._id,
    text: preview,
    sender: "broker",
    whatsappMessageId: messageId || null,
  });

  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { templateSent: true, templateSentAt: new Date() } },
  );

  emitToUser(ownerId, "conversation:newMessage", {
    conversationId: conversation._id,
    leadId: lead._id,
    message,
  });

  return new ApiResponse(201, { message }, "Template sent").send(res);
});

/**
 * POST /api/conversations/:id/takeover
 * "Take Over Chat" — pauses the AI for this one lead so only the broker replies.
 */
const takeOverChat = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: "manual" } },
    { new: true },
  );
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return new ApiResponse(
    200,
    { conversation },
    "AI paused for this conversation — you have taken over",
  ).send(res);
});

/**
 * POST /api/conversations/:id/resume-ai
 * "Resume AI" — hands the conversation back to the AI engine.
 */
const resumeAI = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: "ai_active", aiBlockedReason: null, aiBlockedAt: null } },
    { new: true },
  );
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return new ApiResponse(
    200,
    { conversation },
    "AI resumed for this conversation",
  ).send(res);
});

/** POST /api/conversations/:id/read — clears the unread badge. */
const markRead = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { unreadCount: 0 } },
    { new: true },
  );
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return new ApiResponse(200, { conversation }).send(res);
});

/** POST /api/conversations/:id/close — marks the conversation closed (won/lost handled via Lead.status separately). */
const closeConversation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: "closed" } },
    { new: true },
  );
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return new ApiResponse(200, { conversation }, "Conversation closed").send(
    res,
  );
});

module.exports = {
  listConversations,
  getConversation,
  sendManualReply,
  sendTemplate,
  takeOverChat,
  resumeAI,
  markRead,
  closeConversation,
};
