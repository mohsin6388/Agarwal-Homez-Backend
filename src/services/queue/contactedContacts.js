const mongoose = require("mongoose");
const OutboundJob = require("../../models/OutboundJob");
const Lead = require("../../models/Lead");
const Campaign = require("../../models/Campaign");
const deliveryHealth = require("../whatsapp/deliveryHealth");

const CHANNEL = "whatsapp";
const RECIPIENT_SKIP_CODES = ["131026", "131049", "131050"];
const CACHE_TTL_MS = 3000;

const GROUPS = {
  all: ["delivered", "awaiting", "retry_later", "cannot_send"], // attempted
  sent: ["delivered", "awaiting"], // successfully sent
  delivered: ["delivered"],
  awaiting: ["awaiting"],
  failed: ["retry_later", "cannot_send"],
  retry_later: ["retry_later"],
  cannot_send: ["cannot_send"],
  queued: ["queued"],
};

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/* ------------------------------------------------------------------ */
/* Pure classification (no DB) — unit-testable                         */
/* ------------------------------------------------------------------ */

/**
 * Failed job + lead ki current WhatsApp health  ->  retry_later | cannot_send
 * Returns { group, code, reason, retryAfter, ready }
 */
function classifyFailure(job, lead, now = new Date()) {
  const code = String(job.deliveryErrorCode || job.lastErrorCode || "");
  const text = (c, fallback) =>
    deliveryHealth.REASON_TEXT[c] ||
    job.deliveryError ||
    job.lastError ||
    fallback;

  const cannot = (c, reason) => ({
    group: "cannot_send",
    code: c || null,
    reason,
    retryAfter: null,
    ready: false,
  });
  const later = (c, reason, retryAfter) => ({
    group: "retry_later",
    code: c || null,
    reason,
    retryAfter: retryAfter || null,
    ready: !retryAfter || new Date(retryAfter) <= now,
  });

  // Worker send se pehle jo rule lagata hai wahi yahan (marketing = sabse strict)
  const block = deliveryHealth.getWhatsAppBlock(lead, "MARKETING", now);
  if (block) {
    if (block.code === deliveryHealth.CODES.MARKETING_OPT_OUT) {
      return cannot(block.code, deliveryHealth.REASON_TEXT["131050"]);
    }
    if (block.code === deliveryHealth.CODES.UNDELIVERABLE) {
      return block.until
        ? later(block.code, deliveryHealth.REASON_TEXT["131026"], block.until)
        : cannot(block.code, deliveryHealth.REASON_TEXT["131026"]);
    }
    // 131049 marketing cooldown
    return later(block.code, deliveryHealth.REASON_TEXT["131049"], block.until);
  }

  // Lead par abhi koi block nahi (cooldown nikal gaya / number wapas ok hua)
  if (code === "130472") {
    return cannot(
      code,
      "User Meta experiment me hai — marketing template nahi jayega",
    );
  }
  if (code === "131050")
    return cannot(code, deliveryHealth.REASON_TEXT["131050"]);
  return later(code, text(code, "Delivery failed"), null);
}

/** Ek lead ka latest relevant job -> group info */
function classifyJob(job, lead, now = new Date()) {
  const base = {
    jobId: String(job._id),
    campaignId: job.campaignId ? String(job.campaignId) : null,
    sentAt: job.sentAt || null,
    at: job.at || job.sentAt || job.updatedAt || null,
  };

  if (job.status === "sent" && job.deliveryStatus !== "failed") {
    const delivered =
      job.deliveryStatus === "delivered" || job.deliveryStatus === "read";
    return {
      ...base,
      group: delivered ? "delivered" : "awaiting",
      code: null,
      reason: delivered
        ? "Delivered"
        : "Meta ne accept kiya, delivery status aana baaki",
      retryAfter: null,
      ready: false,
    };
  }
  return { ...base, ...classifyFailure(job, lead, now) };
}

/* ------------------------------------------------------------------ */
/* DB: state per lead                                                  */
/* ------------------------------------------------------------------ */

const cache = new Map(); // ownerId -> { at, data }

/**
 * { byLead: Map<leadIdStr, info>, queuedIds: Set<leadIdStr> }
 * Short TTL cache: contacts picker har page/search par ye maangta hai.
 */
async function getContactedState(ownerId, { fresh = false } = {}) {
  const key = String(ownerId);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const owner = oid(ownerId);
  const now = new Date();

  // Latest relevant job per lead: sent, failed, ya health-guard se skip hua
  const latest = await OutboundJob.aggregate([
    {
      $match: {
        ownerId: owner,
        channel: CHANNEL,
        $or: [
          { status: { $in: ["sent", "failed"] } },
          { status: "cancelled", lastErrorCode: { $in: RECIPIENT_SKIP_CODES } },
        ],
      },
    },
    { $addFields: { at: { $ifNull: ["$sentAt", "$updatedAt"] } } },
    { $sort: { at: -1 } },
    { $group: { _id: "$leadId", job: { $first: "$$ROOT" } } },
  ]);

  // Failed-type jobs ke liye lead health chahiye
  const needsHealth = latest
    .filter(
      (r) => !(r.job.status === "sent" && r.job.deliveryStatus !== "failed"),
    )
    .map((r) => r._id);
  const leads = needsHealth.length
    ? await Lead.find(
        { _id: { $in: needsHealth } },
        { whatsappHealth: 1 },
      ).lean()
    : [];
  const leadById = new Map(leads.map((l) => [String(l._id), l]));

  const byLead = new Map();
  for (const row of latest) {
    const id = String(row._id);
    byLead.set(id, classifyJob(row.job, leadById.get(id), now));
  }

  // Queue me hain (abhi bheje nahi gaye) — attempted wale alag
  const queuedRaw = await OutboundJob.distinct("leadId", {
    ownerId: owner,
    channel: CHANNEL,
    status: { $in: ["pending", "processing", "paused"] },
  });
  const queuedIds = new Set();
  for (const id of queuedRaw) {
    const k = String(id);
    if (!byLead.has(k)) queuedIds.add(k);
  }

  const data = { byLead, queuedIds };
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Contacts picker se chhupane wale lead ids (attempted + queued) */
async function getHiddenLeadIds(ownerId) {
  const { byLead, queuedIds } = await getContactedState(ownerId);
  return [...byLead.keys(), ...queuedIds].map(oid);
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

async function getSummary(ownerId) {
  const { byLead, queuedIds } = await getContactedState(ownerId, {
    fresh: true,
  });

  const s = {
    contacted: 0, // delivered + awaiting + failed (= jinko bhejne ki koshish hui)
    sent: 0, // delivered + awaiting
    delivered: 0,
    awaiting: 0,
    failed: 0,
    retryLater: { total: 0, ready: 0, waiting: 0, nextRetryAt: null },
    cannotSend: 0,
    queued: queuedIds.size,
  };
  const reasons = new Map();

  for (const info of byLead.values()) {
    s.contacted += 1;
    if (info.group === "delivered") {
      s.delivered += 1;
      s.sent += 1;
    } else if (info.group === "awaiting") {
      s.awaiting += 1;
      s.sent += 1;
    } else {
      s.failed += 1;
      if (info.group === "retry_later") {
        s.retryLater.total += 1;
        if (info.ready) s.retryLater.ready += 1;
        else {
          s.retryLater.waiting += 1;
          const t = new Date(info.retryAfter);
          if (!s.retryLater.nextRetryAt || t < s.retryLater.nextRetryAt) {
            s.retryLater.nextRetryAt = t;
          }
        }
      } else {
        s.cannotSend += 1;
      }
      const key = `${info.group}|${info.code || "unknown"}`;
      const r = reasons.get(key) || {
        group: info.group,
        code: info.code || null,
        reason: info.reason,
        count: 0,
      };
      r.count += 1;
      reasons.set(key, r);
    }
  }

  return {
    summary: s,
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
  };
}

/* ------------------------------------------------------------------ */
/* List (popup / page)                                                 */
/* ------------------------------------------------------------------ */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param group  all | sent | delivered | awaiting | failed | retry_later | cannot_send | queued
 * @param idsOnly true => sirf lead ids (poore group ke) — naye campaign me "select these" ke liye
 */
async function listContacted(
  ownerId,
  { group = "all", search = "", page = 1, limit = 50, idsOnly = false } = {},
) {
  const wanted = new Set(GROUPS[group] || GROUPS.all);
  const { byLead, queuedIds } = await getContactedState(ownerId, {
    fresh: true,
  });
  const now = new Date();

  let entries = [];
  if (group === "queued") {
    entries = [...queuedIds].map((id) => [
      id,
      {
        group: "queued",
        code: null,
        reason: "Campaign queue me hai, abhi bheja nahi gaya",
        retryAfter: null,
        ready: false,
        at: null,
        campaignId: null,
        sentAt: null,
      },
    ]);
  } else {
    entries = [...byLead.entries()].filter(([, info]) =>
      wanted.has(info.group),
    );
  }

  // Search: name / phone
  const q = String(search || "")
    .trim()
    .slice(0, 120);
  if (q && entries.length) {
    const re = new RegExp(escapeRe(q), "i");
    const matching = await Lead.find(
      {
        _id: { $in: entries.map(([id]) => oid(id)) },
        $or: [{ name: re }, { phone: re }],
      },
      { _id: 1 },
    ).lean();
    const ok = new Set(matching.map((l) => String(l._id)));
    entries = entries.filter(([id]) => ok.has(id));
  }

  // Latest pehle
  entries.sort((a, b) => new Date(b[1].at || 0) - new Date(a[1].at || 0));

  if (idsOnly) {
    return { ids: entries.map(([id]) => id), total: entries.length };
  }

  const total = entries.length;
  const pageEntries = entries.slice((page - 1) * limit, page * limit);

  const leads = await Lead.find(
    { _id: { $in: pageEntries.map(([id]) => oid(id)) } },
    { name: 1, phone: 1 },
  ).lean();
  const leadById = new Map(leads.map((l) => [String(l._id), l]));
  const campaignIds = [
    ...new Set(pageEntries.map(([, i]) => i.campaignId).filter(Boolean)),
  ];
  const campaigns = campaignIds.length
    ? await Campaign.find(
        { _id: { $in: campaignIds.map(oid) } },
        { name: 1 },
      ).lean()
    : [];
  const campaignById = new Map(campaigns.map((c) => [String(c._id), c.name]));

  const contacts = pageEntries.map(([id, info]) => {
    const lead = leadById.get(id);
    return {
      leadId: id,
      name: lead?.name || "(deleted lead)",
      phone: lead?.phone || "",
      group: info.group,
      code: info.code,
      reason: info.reason,
      campaignId: info.campaignId,
      campaignName: info.campaignId
        ? campaignById.get(info.campaignId) || null
        : null,
      sentAt: info.sentAt,
      retryAfter: info.retryAfter,
      retryReady: info.group === "retry_later" ? Boolean(info.ready) : null,
    };
  });

  return {
    contacts,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    generatedAt: now,
  };
}

module.exports = {
  GROUPS,
  classifyFailure,
  classifyJob,
  getContactedState,
  getHiddenLeadIds,
  getSummary,
  listContacted,
};
