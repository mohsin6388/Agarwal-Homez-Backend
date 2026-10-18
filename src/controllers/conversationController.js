const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const metaWhatsappClient = require('../services/whatsapp/metaWhatsappClient');
const { recordOutboundMessage } = require('../services/whatsapp/messageStore');
const { emitToUser } = require('../sockets');
const Meeting = require('../models/Meeting');
const FollowUp = require('../models/FollowUp');

/** Brokers see only their own conversations; admins may pass ?ownerId= to inspect a specific broker. */
function scopeOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

/**
 * GET /api/conversations
 * Supports the left-hand filter rail from the spec: unread, hot, warm, cold,
 * site_visit, closed, lost — plus free-text search on the lead's name/phone.
 */
const listConversations = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { filter, search, leadId, page = 1, limit = 50 } = req.query;
  const leadFilter = { ownerId };
  if (leadId) leadFilter._id = leadId;
  if (['warm', 'cold', 'site_visit', 'closed', 'lost'].includes(filter)) leadFilter.status = filter;
  if (search) {
    const escaped = String(search).trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escaped) leadFilter.$or = [{ name: new RegExp(escaped, 'i') }, { phone: new RegExp(escaped, 'i') }];
  }

  let leadIds = await Lead.find(leadFilter).distinct('_id');
  if (filter === 'hot') {
    const [hotLeadIds, hotConversationLeadIds] = await Promise.all([
      Lead.find({ ownerId, leadScore: { $gt: 60 } }).distinct('_id'),
      Conversation.find({ ownerId, currentLeadScore: { $gt: 60 } }).distinct('leadId'),
    ]);
    const hotSet = new Set([...hotLeadIds, ...hotConversationLeadIds].map(String));
    leadIds = leadIds.filter((id) => hotSet.has(String(id)));
  }
  if (!leadIds.length) return new ApiResponse(200, { conversations: [], pagination: { page, limit, total: 0, totalPages: 0 } }).send(res);

  // Imported contacts may have an empty shell. Only threads with real activity are visible.
  // Scope Message queries through this owner's lead IDs to avoid cross-owner scans.
  const activeConversationIds = await Message.distinct('conversationId', {
    leadId: { $in: leadIds },
    $or: [
      { direction: 'inbound', sender: 'customer' },
      { direction: 'outbound', status: { $in: ['sent', 'delivered', 'read'] } },
    ],
  });
  const convFilter = { ownerId, leadId: { $in: leadIds }, _id: { $in: activeConversationIds } };
  if (filter === 'unread') convFilter.unreadCount = { $gt: 0 };
  if (filter === 'needs_reply') {
    const latest = activeConversationIds.length ? await Message.aggregate([
      { $match: { conversationId: { $in: activeConversationIds }, leadId: { $in: leadIds } } },
      { $sort: { timestamp: -1, _id: -1 } },
      { $group: { _id: '$conversationId', latestSender: { $first: '$sender' }, latestDirection: { $first: '$direction' } } },
    ]) : [];
    const inboundIds = latest.filter((m) => m.latestSender === 'customer' || m.latestDirection === 'inbound').map((m) => m._id);
    convFilter._id = { $in: inboundIds };
    convFilter.status = { $in: ['manual', 'paused', 'closed'] };
  }

  const [conversations, total] = await Promise.all([
    Conversation.find(convFilter)
      .populate('leadId', 'name phone email city location status leadScore source budgetMin budgetMax occupation')
      .populate('recommendedProperties', 'projectName city bhk status')
      .sort({ lastMessageAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean(),
    Conversation.countDocuments(convFilter),
  ]);

  const ids = conversations.map((c) => c._id);
  const leadIdsForFacts = conversations.map((c) => c.leadId?._id).filter(Boolean);
  const [lastMessages, meetings, followUps] = await Promise.all([
    ids.length ? Message.aggregate([
      { $match: { conversationId: { $in: ids } } },
      { $sort: { timestamp: -1, _id: -1 } },
      { $group: { _id: '$conversationId', message: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$message' } },
    ]) : [],
    leadIdsForFacts.length ? Meeting.find({ ownerId, leadId: { $in: leadIdsForFacts }, status: { $in: ['scheduled', 'rescheduled'] } }).sort({ preferredDate: 1, preferredTime: 1 }).populate('propertyId', 'projectName bhk city').lean() : [],
    leadIdsForFacts.length ? FollowUp.find({ ownerId, leadId: { $in: leadIdsForFacts }, status: 'pending' }).sort({ nextFollowUpDate: 1 }).lean() : [],
  ]);
  const lastByConversation = new Map();
  for (const m of lastMessages) if (!lastByConversation.has(String(m.conversationId))) lastByConversation.set(String(m.conversationId), m);
  const meetingByLead = new Map();
  for (const m of meetings) if (!meetingByLead.has(String(m.leadId))) meetingByLead.set(String(m.leadId), m);
  const followByLead = new Map();
  for (const fu of followUps) if (!followByLead.has(String(fu.leadId))) followByLead.set(String(fu.leadId), fu);
  const enriched = conversations.map((c) => {
    const lead = c.leadId || {};
    const last = lastByConversation.get(String(c._id));
    const meeting = meetingByLead.get(String(lead._id));
    const follow = followByLead.get(String(lead._id));
    const score = Number(c.currentLeadScore || lead.leadScore || 0);
    const inboundLast = Boolean(last && (last.sender === 'customer' || last.direction === 'inbound'));
    const needsReply = inboundLast && (['manual', 'paused', 'closed'].includes(c.status) || (Number(c.unreadCount || 0) > 0 && c.status !== 'ai_active'));
    return {
      ...c,
      tag: meeting ? 'visit' : score > 60 ? 'hot' : 'lead',
      needsReply,
      lastMessagePreview: last?.text || '',
      lastMessageAt: last?.timestamp || c.lastMessageAt || null,
      lastMessageSender: last?.sender || null,
      facts: {
        requirement: c.collectedRequirements || lead.requirements || {},
        budget: lead.budgetMin != null || lead.budgetMax != null ? { min: lead.budgetMin, max: lead.budgetMax } : null,
        location: lead.city || lead.location || null,
        siteVisit: meeting || null,
      },
      nextStep: follow?.nextFollowUpMessage || c.nextStep || '',
    };
  });
  return new ApiResponse(200, { conversations: enriched, pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / limit) } }).send(res);
});

/**
 * GET /api/conversations/:id
 * Full thread for the right-hand panel: lead profile, AI summary, score,
 * recommended properties, meeting status, and paginated message history.
 */
const getConversation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { page = 1, limit = 50 } = req.query;

  const conversation = await Conversation.findOne({ _id: req.params.id, ownerId })
    .populate('leadId')
    .populate('recommendedProperties');
  if (!conversation) throw ApiError.notFound('Conversation not found');

  const [messages, messageCount] = await Promise.all([
    Message.find({ conversationId: conversation._id })
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean(),
    Message.countDocuments({ conversationId: conversation._id }),
  ]);
  messages.reverse(); // oldest -> newest for chat UI rendering
  const [latestMeeting, pendingFollowUp] = await Promise.all([
    Meeting.findOne({ ownerId, leadId: conversation.leadId?._id, status: { $in: ['scheduled', 'rescheduled'] } }).sort({ preferredDate: 1 }).populate('propertyId', 'projectName bhk').lean(),
    FollowUp.findOne({ ownerId, leadId: conversation.leadId?._id, status: 'pending' }).sort({ nextFollowUpDate: 1 }).lean(),
  ]);
  const conversationData = conversation.toObject();
  conversationData.facts = { requirement: conversationData.collectedRequirements || conversationData.leadId?.requirements || '', budget: { min: conversationData.leadId?.budgetMin ?? null, max: conversationData.leadId?.budgetMax ?? null }, location: conversationData.leadId?.city || conversationData.leadId?.location || '', siteVisit: latestMeeting || null };
  conversationData.nextStep = pendingFollowUp?.nextFollowUpMessage || conversationData.nextStep || '';

  return new ApiResponse(200, {
    conversation: conversationData,
    messages,
    pagination: { page: Number(page), limit: Number(limit), total: messageCount },
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

  const conversation = await Conversation.findOne({ _id: req.params.id, ownerId }).populate('leadId');
  if (!conversation) throw ApiError.notFound('Conversation not found');
  if (!conversation.leadId) throw ApiError.badRequest('This conversation has no associated lead');

  const settingsService = require('../services/settings/settingsService');
  const settings = await settingsService.getOrCreateSettings();
  if (settings.whatsappDisconnected) {
    throw ApiError.badRequest('WhatsApp is disconnected — reconnect it from Settings first');
  }

  // Free-text is only allowed while the WhatsApp 24h customer-service
  // window is open. That window starts from the lead's last inbound message,
  // not from our last outbound message.
  const lastInboundAt = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  const within24Hours = lastInboundAt > 0 && (Date.now() - lastInboundAt) < 24 * 60 * 60 * 1000;

  if (!within24Hours) {
    throw ApiError.badRequest(
      'WHATSAPP_24H_WINDOW_CLOSED: The lead has not messaged this WhatsApp number within the last 24 hours. Send an approved WhatsApp template first.'
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
    sender: 'broker',
    whatsappMessageId: messageId || null,
  });

  emitToUser(ownerId, 'conversation:newMessage', { conversationId: conversation._id, leadId: conversation.leadId._id, message });

  return new ApiResponse(201, { message }, 'Message sent').send(res);
});

/**
 * POST /api/conversations/:id/takeover
 * "Take Over Chat" — pauses the AI for this one lead so only the broker replies.
 */
const takeOverChat = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: 'manual' } },
    { new: true }
  );
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return new ApiResponse(200, { conversation }, 'AI paused for this conversation — you have taken over').send(res);
});

/**
 * POST /api/conversations/:id/resume-ai
 * "Resume AI" — hands the conversation back to the AI engine.
 */
const resumeAI = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: 'ai_active' } },
    { new: true }
  );
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return new ApiResponse(200, { conversation }, 'AI resumed for this conversation').send(res);
});

/** POST /api/conversations/:id/read — clears the unread badge. */
const markRead = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { unreadCount: 0 } },
    { new: true }
  );
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return new ApiResponse(200, { conversation }).send(res);
});

/** POST /api/conversations/:id/close — marks the conversation closed (won/lost handled via Lead.status separately). */
const closeConversation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: 'closed' } },
    { new: true }
  );
  if (!conversation) throw ApiError.notFound('Conversation not found');
  return new ApiResponse(200, { conversation }, 'Conversation closed').send(res);
});

module.exports = {
  listConversations,
  getConversation,
  sendManualReply,
  takeOverChat,
  resumeAI,
  markRead,
  closeConversation,
};
