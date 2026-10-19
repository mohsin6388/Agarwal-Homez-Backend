const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const FollowUp = require('../models/FollowUp');
const Conversation = require('../models/Conversation');
const EmailMessage = require('../models/EmailMessage');

function scopeOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

/** GET /api/followups — pending follow-ups queue, oldest-due first. */
const listFollowUps = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { status, page, limit, due } = req.query;
  const filter = { ownerId };
  filter.status = status || 'pending';
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const today = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 60 * 60 * 1000);
  const tomorrow = new Date(today.getTime() + 86400000);
  const week = new Date(today.getTime() + 7 * 86400000);
  if (due === 'late') { filter.status = 'pending'; filter.nextFollowUpDate = { $lt: today }; }
  else if (due === 'today') { filter.status = 'pending'; filter.nextFollowUpDate = { $gte: today, $lt: tomorrow }; }
  else if (due === 'week') { filter.status = 'pending'; filter.nextFollowUpDate = { $gte: today, $lt: week }; }

  const [followUps, total, counts] = await Promise.all([
    FollowUp.find(filter)
      .populate('leadId', 'name phone email city leadScore status')
      .sort({ nextFollowUpDate: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    FollowUp.countDocuments(filter),
    Promise.all([FollowUp.countDocuments({ ownerId, status: 'pending' }), FollowUp.countDocuments({ ownerId, status: 'pending', nextFollowUpDate: { $lt: today } }), FollowUp.countDocuments({ ownerId, status: 'pending', nextFollowUpDate: { $gte: today, $lt: tomorrow } }), FollowUp.countDocuments({ ownerId, status: 'pending', nextFollowUpDate: { $gte: today, $lt: week } })]),
  ]);
  const leadIds = followUps.map((item) => item.leadId?._id).filter(Boolean);
  const conversations = leadIds.length
    ? await Conversation.find({ ownerId, leadId: { $in: leadIds } })
        .select('leadId aiSummary currentLeadScore lastIntent lastSentiment status lastMessageAt')
        .lean()
    : [];
  const conversationMap = new Map(conversations.map((item) => [String(item.leadId), item]));
  const emailMessages = leadIds.length ? await EmailMessage.find({ ownerId, leadId: { $in: leadIds } }).sort({ createdAt: -1 }).select('leadId text createdAt direction threadId').lean() : [];
  const emailMap = new Map(); for (const item of emailMessages) if (!emailMap.has(String(item.leadId))) emailMap.set(String(item.leadId), item);
  const enriched = followUps.map((item) => {
    const conversation = item.leadId ? (conversationMap.get(String(item.leadId._id)) || null) : null;
    const email = item.leadId ? (emailMap.get(String(item.leadId._id)) || null) : null;
    const emailIsNewer = email && (!conversation?.lastMessageAt || new Date(email.createdAt) > new Date(conversation.lastMessageAt));
    return { ...item, conversation, channel: emailIsNewer ? 'email' : 'whatsapp', emailThreadId: emailIsNewer && email ? String(email.threadId || email._id) : null, lastContactAt: emailIsNewer ? email.createdAt : conversation?.lastMessageAt || email?.createdAt || null, summary: conversation?.aiSummary || (email ? String(email.text || '').slice(0, 240) : ''),
    leadTemperature: item.leadId?.status === 'hot' || Number(item.buyingProbability || 0) >= 70 ? 'hot'
      : item.leadId?.status === 'cold' || Number(item.buyingProbability || 0) <= 30 ? 'cold' : 'warm',
  }; });

  return new ApiResponse(200, {
    followUps: enriched,
    counts: { all: counts[0], late: counts[1], today: counts[2], week: counts[3] },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/** PATCH /api/followups/:id — mark done/skipped, or manually adjust date/message. */
const updateFollowUp = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const patch = { ...req.body };
  if (patch.snoozeDays !== undefined) { patch.nextFollowUpDate = new Date(Date.now() + Number(patch.snoozeDays) * 86400000); delete patch.snoozeDays; patch.status = 'pending'; }
  const followUp = await FollowUp.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: patch },
    { new: true, runValidators: true }
  );
  if (!followUp) throw ApiError.notFound('Follow-up not found');
  return new ApiResponse(200, { followUp }, 'Follow-up updated').send(res);
});

/** DELETE /api/followups/:id — permanently removes a follow-up from the queue. */
const deleteFollowUp = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const followUp = await FollowUp.findOneAndDelete({ _id: req.params.id, ownerId });
  if (!followUp) throw ApiError.notFound('Follow-up not found');
  return new ApiResponse(200, null, 'Follow-up deleted').send(res);
});

module.exports = { listFollowUps, updateFollowUp, deleteFollowUp };
