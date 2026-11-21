const mongoose = require("mongoose");
const OutboundJob = require("../../models/OutboundJob");
const Message = require("../../models/Message");
const Campaign = require("../../models/Campaign");
const Lead = require("../../models/Lead");
const contacted = require("./contactedContacts");

/**
 * Campaign ke failed WhatsApp contacts.
 *
 * Do tarah ke failure hote hain:
 *  1. send   — Meta API ne bhejte waqt hi mana kar diya   → job.status = "failed"
 *  2. meta   — Meta ne accept kiya ("sent"), phir webhook se bataya ki deliver
 *              nahi hua                                    → job.status = "sent",
 *                                                            job.deliveryStatus = "failed"
 *
 * Pehle ye file purane fields (deliveryFailed / retryable / retryAfter) padhti
 * thi jo ab OutboundJob model me nahi hain — isliye campaign card par failures
 * dikhte hi nahi the. Ab dono type `deliveryStatus` / `status` se gine jaate
 * hain, aur retry ka rule wahi hai jo "Bheje gaye contacts" popup use karta hai
 * (contactedContacts.classifyFailure: 131026 / 131049 / 131050 / 130472 ...).
 */

// Ek job par max kitni baar resend. Meta baar-baar retry par quality girata hai.
const MAX_DELIVERY_RETRIES = 2;

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/** Failed WhatsApp jobs (dono type) ka Mongo filter */
function failedMatch(extra = {}) {
  return {
    channel: "whatsapp",
    ...extra,
    $or: [{ status: "failed" }, { status: "sent", deliveryStatus: "failed" }],
  };
}

const JOB_FIELDS =
  "_id campaignId leadId status deliveryStatus deliveryErrorCode deliveryError deliveryUpdatedAt lastError lastErrorCode deliveryRetryCount sentAt updatedAt";

/**
 * Ek failed job → { kind, state, code, reason, retryAfter, retryable, retryCount }
 * state: ready (abhi resend ho sakta) | waiting (cooldown) | blocked (kabhi nahi)
 */
function describe(job, lead, now = new Date()) {
  const kind =
    job.status === "sent" && job.deliveryStatus === "failed" ? "meta" : "send";
  const info = contacted.classifyFailure(job, lead, now);
  const retryCount = job.deliveryRetryCount || 0;
  const exhausted = retryCount >= MAX_DELIVERY_RETRIES;

  let state;
  if (info.group === "cannot_send" || exhausted) state = "blocked";
  else state = info.ready ? "ready" : "waiting";

  const code = info.code || job.deliveryErrorCode || job.lastErrorCode || null;
  const reason = exhausted
    ? `${info.reason || "Delivery failed"} — max ${MAX_DELIVERY_RETRIES} retry ho chuke`
    : info.reason || "Delivery failed";

  return {
    kind,
    state,
    code,
    reason,
    retryAfter: state === "waiting" ? info.retryAfter : null,
    retryable: state !== "blocked",
    retryCount,
  };
}

async function loadLeads(jobs) {
  const ids = [...new Set(jobs.map((j) => String(j.leadId)).filter(Boolean))];
  if (!ids.length) return new Map();
  const leads = await Lead.find(
    { _id: { $in: ids.map(oid) } },
    { name: 1, phone: 1, whatsappHealth: 1 },
  ).lean();
  return new Map(leads.map((l) => [String(l._id), l]));
}

const emptySummary = () => ({
  total: 0,
  meta: 0, // Meta webhook se deliver nahi hua
  send: 0, // bhejte waqt hi fail
  ready: 0,
  waiting: 0,
  blocked: 0,
  nextReadyAt: null,
  reasons: [], // [{ code, reason, count }] sabse zyada pehle
});

function addTo(summary, d, reasonCounts) {
  summary.total += 1;
  summary[d.kind] += 1;
  summary[d.state] += 1;
  if (
    d.state === "waiting" &&
    d.retryAfter &&
    (!summary.nextReadyAt ||
      new Date(d.retryAfter) < new Date(summary.nextReadyAt))
  ) {
    summary.nextReadyAt = d.retryAfter;
  }
  const key = `${d.code || "-"}|${d.reason}`;
  const row = reasonCounts.get(key) || {
    code: d.code,
    reason: d.reason,
    count: 0,
  };
  row.count += 1;
  reasonCounts.set(key, row);
}

function finish(summary, reasonCounts, top = 5) {
  summary.reasons = [...reasonCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
  return summary;
}

/** Campaigns ki list ke liye: Map<campaignIdString, summary> */
async function summarizeForCampaigns(campaignIds) {
  const out = new Map();
  if (!campaignIds?.length) return out;

  const jobs = await OutboundJob.find(
    failedMatch({ campaignId: { $in: campaignIds.map(oid) } }),
  )
    .select(JOB_FIELDS)
    .lean();
  if (!jobs.length) return out;

  const leadById = await loadLeads(jobs);
  const now = new Date();
  const reasonsBy = new Map();
  for (const job of jobs) {
    const key = String(job.campaignId);
    if (!out.has(key)) {
      out.set(key, emptySummary());
      reasonsBy.set(key, new Map());
    }
    addTo(
      out.get(key),
      describe(job, leadById.get(String(job.leadId)), now),
      reasonsBy.get(key),
    );
  }
  for (const [key, summary] of out) finish(summary, reasonsBy.get(key), 3);
  return out;
}

/** Popup ke liye: summary + har failed contact */
async function getFailureDetails(ownerId, campaignId) {
  const campaign = await Campaign.findOne({
    _id: campaignId,
    ownerId,
    deletedAt: null,
  }).lean();
  if (!campaign) return null;

  const jobs = await OutboundJob.find(
    failedMatch({ ownerId: oid(ownerId), campaignId: campaign._id }),
  )
    .select(JOB_FIELDS)
    .sort({ deliveryUpdatedAt: -1, updatedAt: -1 })
    .limit(5000)
    .lean();

  const leadById = await loadLeads(jobs);
  const now = new Date();
  const summary = emptySummary();
  const reasonCounts = new Map();
  const contacts = jobs.map((j) => {
    const lead = leadById.get(String(j.leadId));
    const d = describe(j, lead, now);
    addTo(summary, d, reasonCounts);
    return {
      jobId: String(j._id),
      leadId: j.leadId ? String(j.leadId) : null,
      name: lead?.name || "(deleted lead)",
      phone: lead?.phone || "",
      kind: d.kind,
      errorCode: d.code,
      reason: d.reason,
      failedAt: j.deliveryUpdatedAt || j.updatedAt || j.sentAt || null,
      retryAfter: d.retryAfter,
      retryable: d.retryable,
      retryCount: d.retryCount,
      state: d.state,
    };
  });

  return {
    campaign: { _id: String(campaign._id), name: campaign.name },
    summary: finish(summary, reasonCounts),
    maxRetries: MAX_DELIVERY_RETRIES,
    contacts,
  };
}

/**
 * Jo failed contacts "ready" hain (cooldown khatam + retry allowed + max retry
 * nahi hua) unhe usi campaign me wapas queue karo. Same template, same worker.
 */
async function retryReadyFailures(ownerId, campaignId) {
  const campaign = await Campaign.findOne({
    _id: campaignId,
    ownerId,
    deletedAt: null,
  });
  if (!campaign) return null;
  if (campaign.status === "cancelled") {
    return { campaign, requeued: 0, reason: "campaign_cancelled" };
  }

  const jobs = await OutboundJob.find(
    failedMatch({ ownerId: oid(ownerId), campaignId: campaign._id }),
  )
    .select(JOB_FIELDS)
    .lean();
  const leadById = await loadLeads(jobs);
  const now = new Date();
  const ids = jobs
    .filter(
      (j) => describe(j, leadById.get(String(j.leadId)), now).state === "ready",
    )
    .map((j) => j._id);

  if (!ids.length) return { campaign, requeued: 0, reason: "none_ready" };

  // Purani failed Message history me rahe, par uska outboundJobId hata do —
  // warna startConversation use "already_started" maan kar naya message
  // bheje bina job ko "sent" mark kar dega.
  await Message.updateMany(
    { outboundJobId: { $in: ids } },
    { $set: { outboundJobId: null } },
  );

  const res = await OutboundJob.updateMany(failedMatch({ _id: { $in: ids } }), {
    $set: {
      // Campaign paused hai to jobs bhi paused rahen, resume par chalenge
      status: campaign.status === "paused" ? "paused" : "pending",
      attempts: 0,
      nextRunAt: now,
      lockedAt: null,
      sentAt: null,
      lastError: null,
      lastErrorCode: null,
      deliveryStatus: null,
      deliveryErrorCode: null,
      deliveryError: null,
      deliveryUpdatedAt: null,
    },
    $inc: { deliveryRetryCount: 1 },
  });

  if (res.modifiedCount && campaign.status === "completed") {
    campaign.status = "active";
    campaign.completedAt = null;
    await campaign.save();
  }

  return { campaign, requeued: res.modifiedCount, reason: null };
}

module.exports = {
  MAX_DELIVERY_RETRIES,
  failedMatch,
  describe,
  summarizeForCampaigns,
  getFailureDetails,
  retryReadyFailures,
};
