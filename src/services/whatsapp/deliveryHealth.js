const Lead = require("../../models/Lead");
const OutboundJob = require("../../models/OutboundJob");
const Notification = require("../../models/Notification");
const { emitToUser } = require("../../sockets");
const logger = require("../../utils/logger");

/**
 * WhatsApp deliverability guard.
 *
 * Meta "sent" (HTTP 200) ke baad bhi message drop kar sakta hai — wo async
 * `statuses[].status = failed` webhook se batata hai. Ye module un failures ko
 * samajh ke lead par yaad rakhta hai, taaki:
 *
 *   131026  number WhatsApp par nahi / undeliverable  -> number "invalid", aage skip
 *   131049  per-user marketing limit (healthy ecosystem) -> us number par marketing
 *           template 7 / 14 / 30 din ke liye band (escalating cooldown)
 *   131050  user ne marketing messages stop kiye        -> marketing permanently band
 *
 * Bar-bar bekaar numbers par bhejne se block/report badhte hain, phone number ki
 * quality rating girti hai aur Meta messaging limit kam kar deta hai (131048).
 *
 * Saath mein ek circuit breaker hai: agar recent deliveries mein failure rate
 * bahut zyada hai, ya Meta ne number FLAGGED / DOWNGRADE kiya, to bulk WhatsApp
 * automatically ruk jaata hai.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const CONFIG = {
  // 131049 cooldowns (1st, 2nd, 3rd+ block)
  marketingCooldownDays: [7, 14, 30],
  // 131026 ek baar aaya to itne din skip; 2 baar aaya to tab tak skip jab tak
  // number khud message na kare ya delivered na ho
  invalidRecheckDays: num(process.env.WA_INVALID_RECHECK_DAYS, 60),
  invalidPermanentAfter: 2,
  // Circuit breaker
  breakerMinSamples: num(process.env.WA_BREAKER_MIN_SAMPLES, 40),
  breakerFailRate: num(process.env.WA_BREAKER_FAIL_RATE, 0.5),
  breakerWindow: num(process.env.WA_BREAKER_WINDOW, 100),
  breakerHoldMs: num(process.env.WA_BREAKER_HOLD_HOURS, 6) * HOUR,
  qualityHoldMs: num(process.env.WA_QUALITY_HOLD_HOURS, 24) * HOUR,
};

const CODES = {
  UNDELIVERABLE: "131026",
  ECOSYSTEM: "131049",
  MARKETING_OPT_OUT: "131050",
};

const REASON_TEXT = {
  131026: "Number WhatsApp par nahi hai ya message undeliverable",
  131049: "Meta ne marketing message roka (per-user marketing limit)",
  131050: "User ne is business ke marketing messages stop kiye hain",
};

/* ------------------------------------------------------------------ */
/* Template category                                                   */
/* ------------------------------------------------------------------ */

/** Unknown/empty category ko MARKETING maano — safe side */
function isMarketingCategory(category) {
  const c = String(category || "").toUpperCase();
  return c !== "UTILITY" && c !== "AUTHENTICATION";
}

/* ------------------------------------------------------------------ */
/* Send-time eligibility                                               */
/* ------------------------------------------------------------------ */

/**
 * Lead ko is template category se abhi bhejna chahiye ya nahi.
 * @returns {null | { code: string, reason: string, until?: Date }}
 */
function getWhatsAppBlock(lead, category, now = new Date()) {
  const h = lead?.whatsappHealth || {};

  if (h.status === "invalid") {
    const permanent = (h.invalidCount || 0) >= CONFIG.invalidPermanentAfter;
    const recheckAt = h.invalidAt
      ? new Date(
          new Date(h.invalidAt).getTime() + CONFIG.invalidRecheckDays * DAY,
        )
      : null;
    if (permanent || !recheckAt || recheckAt > now) {
      return {
        code: CODES.UNDELIVERABLE,
        reason: `${REASON_TEXT["131026"]} — skip kiya`,
        until: permanent ? null : recheckAt,
      };
    }
  }

  if (isMarketingCategory(category)) {
    if (h.marketingOptOut) {
      return {
        code: CODES.MARKETING_OPT_OUT,
        reason: `${REASON_TEXT["131050"]} — skip kiya`,
      };
    }
    if (h.marketingBlockedUntil && new Date(h.marketingBlockedUntil) > now) {
      return {
        code: CODES.ECOSYSTEM,
        reason: `Marketing cooldown (131049) — ${new Date(h.marketingBlockedUntil).toISOString().slice(0, 10)} tak skip`,
        until: new Date(h.marketingBlockedUntil),
      };
    }
  }
  return null;
}

/** Mongo filter: launch time par sirf bhejne layak leads (category ke hisaab se) */
function eligibleLeadFilter(category, now = new Date()) {
  const invalidRecheckCutoff = new Date(
    now.getTime() - CONFIG.invalidRecheckDays * DAY,
  );
  const notInvalid = {
    $or: [
      { "whatsappHealth.status": { $ne: "invalid" } },
      {
        "whatsappHealth.invalidCount": { $lt: CONFIG.invalidPermanentAfter },
        "whatsappHealth.invalidAt": { $lte: invalidRecheckCutoff },
      },
    ],
  };
  if (!isMarketingCategory(category)) return notInvalid;
  return {
    $and: [
      notInvalid,
      { "whatsappHealth.marketingOptOut": { $ne: true } },
      {
        $or: [
          { "whatsappHealth.marketingBlockedUntil": null },
          { "whatsappHealth.marketingBlockedUntil": { $exists: false } },
          { "whatsappHealth.marketingBlockedUntil": { $lte: now } },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Recording outcomes on the lead                                      */
/* ------------------------------------------------------------------ */

async function recordFailure(leadId, code, { category } = {}) {
  if (!leadId) return;
  code = String(code || "");
  const now = new Date();
  const base = {
    "whatsappHealth.lastErrorCode": code || null,
    "whatsappHealth.lastErrorAt": now,
  };

  try {
    if (code === CODES.UNDELIVERABLE) {
      await Lead.updateOne(
        { _id: leadId },
        {
          $set: {
            ...base,
            "whatsappHealth.status": "invalid",
            "whatsappHealth.invalidAt": now,
          },
          $inc: { "whatsappHealth.invalidCount": 1 },
        },
      );
      return;
    }

    if (code === CODES.ECOSYSTEM) {
      // 131049 sirf marketing par lagta hai. Agar utility template par aaya to
      // Meta ne template ko marketing maana hai — tab bhi cooldown lagao.
      const lead = await Lead.findById(leadId, { whatsappHealth: 1 }).lean();
      const count = (lead?.whatsappHealth?.marketingBlockCount || 0) + 1;
      const days =
        CONFIG.marketingCooldownDays[
          Math.min(count - 1, CONFIG.marketingCooldownDays.length - 1)
        ];
      await Lead.updateOne(
        { _id: leadId },
        {
          $set: {
            ...base,
            "whatsappHealth.marketingBlockedUntil": new Date(
              now.getTime() + days * DAY,
            ),
            "whatsappHealth.marketingBlockCount": count,
          },
        },
      );
      if (category && !isMarketingCategory(category)) {
        logger.warn(
          "[wa-health] 131049 on a non-marketing template — Meta shayad isse MARKETING maan raha hai, template copy check karo",
          { leadId: String(leadId), category },
        );
      }
      return;
    }

    if (code === CODES.MARKETING_OPT_OUT) {
      await setMarketingOptOut({ leadId }, true);
      await Lead.updateOne({ _id: leadId }, { $set: base });
      return;
    }

    await Lead.updateOne({ _id: leadId }, { $set: base });
  } catch (err) {
    logger.warn("[wa-health] Could not record failure", { error: err.message });
  }
}

/** Delivered / read / inbound message => number zinda hai, invalid hata do */
async function recordReachable(leadId) {
  if (!leadId) return;
  try {
    await Lead.updateOne(
      { _id: leadId },
      {
        $set: {
          "whatsappHealth.status": "ok",
          "whatsappHealth.invalidCount": 0,
          "whatsappHealth.invalidAt": null,
          "whatsappHealth.lastDeliveredAt": new Date(),
        },
      },
    );
  } catch (err) {
    logger.warn("[wa-health] Could not record delivery", {
      error: err.message,
    });
  }
}

async function setMarketingOptOut({ leadId, lead }, optOut) {
  const id = leadId || lead?._id;
  if (!id) return;
  await Lead.updateOne(
    { _id: id },
    {
      $set: {
        "whatsappHealth.marketingOptOut": Boolean(optOut),
        "whatsappHealth.marketingOptOutAt": optOut ? new Date() : null,
      },
    },
  );
}

/* ------------------------------------------------------------------ */
/* STOP-keyword detection for inbound replies                          */
/* ------------------------------------------------------------------ */

const OPT_OUT_PATTERNS = [
  /^stop\b/,
  /^unsubscribe\b/,
  /^stop (messages?|msgs?|sending)\b/,
  /^not interested\b/,
  /^no (more )?(messages?|msgs?)\b/,
  /^(mat|mt) bhejo\b/,
  /^(message|msg|messages) (mat|mt|band) (bhejo|karo)\b/,
  /^band karo\b/,
  /^dobara (mat|mt) bhejna\b/,
];

/** Sirf chhote, saaf STOP jaise replies (lambi baat-cheet ko opt-out mat maano) */
function isOptOutText(text) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 40) return false;
  return OPT_OUT_PATTERNS.some((re) => re.test(t));
}

/* ------------------------------------------------------------------ */
/* Circuit breaker (bulk WhatsApp hold)                                */
/* ------------------------------------------------------------------ */

const hold = { until: 0, reason: "" };
const outcomes = []; // true = delivered, false = failed

function getWhatsAppHold() {
  return hold.until > Date.now() ? { ...hold } : null;
}

function clearWhatsAppHold() {
  hold.until = 0;
  hold.reason = "";
  outcomes.length = 0;
}

async function notifyOwner(ownerId, title, body) {
  if (!ownerId) return;
  try {
    await Notification.create({
      userId: ownerId,
      type: "whatsapp_send_failed",
      title,
      body,
      link: "/outreach/whatsapp",
    });
    emitToUser(ownerId, "notification:new", {});
  } catch (err) {
    logger.warn("[wa-health] Could not notify owner", { error: err.message });
  }
}

async function setHold(ms, reason, ownerId) {
  const until = Date.now() + ms;
  if (until <= hold.until) return; // already held longer
  hold.until = until;
  hold.reason = reason;
  outcomes.length = 0;
  logger.warn(
    `[wa-health] Bulk WhatsApp HOLD ${Math.round(ms / HOUR)}h — ${reason}`,
  );
  await notifyOwner(
    ownerId,
    `Bulk WhatsApp ${Math.round(ms / HOUR)} ghante ke liye roka gaya`,
    `${reason}. Number ki quality bachane ke liye sending ruka hai; jobs safe hain aur ` +
      `baad mein apne aap chalenge. WhatsApp Manager mein phone number quality check karo ` +
      `aur contact list saaf karo.`,
  );
}

/** Webhook har delivered/failed par call karta hai */
async function trackOutcome(ownerId, delivered) {
  outcomes.push(Boolean(delivered));
  if (outcomes.length > CONFIG.breakerWindow) outcomes.shift();
  if (outcomes.length < CONFIG.breakerMinSamples) return;

  const failed = outcomes.filter((x) => !x).length;
  const rate = failed / outcomes.length;
  if (rate >= CONFIG.breakerFailRate) {
    await setHold(
      CONFIG.breakerHoldMs,
      `Pichhle ${outcomes.length} messages mein ${Math.round(rate * 100)}% delivery fail hui`,
      ownerId,
    );
  }
}

/**
 * `phone_number_quality_update` webhook.
 * event: FLAGGED | UNFLAGGED | DOWNGRADE | UPGRADE (+ current_limit)
 */
async function handleQualityUpdate(value, ownerIds = []) {
  const event = String(value?.event || "").toUpperCase();
  logger.warn("[wa-health] Phone number quality update", {
    event,
    phone: value?.display_phone_number,
    currentLimit: value?.current_limit,
  });
  if (event === "FLAGGED" || event === "DOWNGRADE") {
    const reason =
      event === "FLAGGED"
        ? "Meta ne aapka WhatsApp number FLAGGED kiya (quality LOW)"
        : `Meta ne messaging limit DOWNGRADE ki (${value?.current_limit || "?"})`;
    for (const ownerId of ownerIds.length ? ownerIds : [null]) {
      await setHold(CONFIG.qualityHoldMs, reason, ownerId);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Webhook status -> job + lead                                        */
/* ------------------------------------------------------------------ */

/**
 * Message status webhook (delivered / read / failed) ko outbound job aur lead
 * tak pahunchata hai. `message` = saved Message doc (leadId, outboundJobId).
 */
async function applyStatus(message, status, firstError) {
  if (!message) return;
  const code = firstError?.code != null ? String(firstError.code) : null;

  let job = null;
  if (message.outboundJobId) {
    const update =
      status === "failed"
        ? {
            deliveryStatus: "failed",
            deliveryErrorCode: code,
            deliveryError:
              REASON_TEXT[code] ||
              firstError?.error_data?.details ||
              firstError?.title ||
              firstError?.message ||
              "Delivery failed",
            deliveryUpdatedAt: new Date(),
          }
        : { deliveryStatus: status, deliveryUpdatedAt: new Date() };
    // read ke baad late "delivered" aaye to read ko overwrite mat karo
    const filter =
      status === "delivered"
        ? { _id: message.outboundJobId, deliveryStatus: { $ne: "read" } }
        : { _id: message.outboundJobId };
    job = await OutboundJob.findOneAndUpdate(
      filter,
      { $set: update },
      { new: true },
    ).lean();
  }

  const ownerId = job?.ownerId || null;
  const isBulk = Boolean(job?.campaignId);

  if (status === "failed") {
    let category = null;
    if (job?.campaignId) {
      const Campaign = require("../../models/Campaign");
      const c = await Campaign.findById(job.campaignId, {
        whatsappTemplate: 1,
      }).lean();
      category = c?.whatsappTemplate?.category || null;
    }
    await recordFailure(message.leadId, code, { category });
    if (isBulk) await trackOutcome(ownerId, false);
  } else if (status === "delivered" || status === "read") {
    await recordReachable(message.leadId);
    if (isBulk && status === "delivered") await trackOutcome(ownerId, true);
  }

  if (job && ownerId) {
    emitToUser(ownerId, "outreach:delivery", {
      jobId: String(job._id),
      campaignId: job.campaignId ? String(job.campaignId) : null,
      leadId: String(message.leadId),
      deliveryStatus: job.deliveryStatus,
      deliveryErrorCode: job.deliveryErrorCode,
      deliveryError: job.deliveryError,
    });
  }
}

module.exports = {
  CODES,
  CONFIG,
  REASON_TEXT,
  isMarketingCategory,
  getWhatsAppBlock,
  eligibleLeadFilter,
  recordFailure,
  recordReachable,
  setMarketingOptOut,
  isOptOutText,
  getWhatsAppHold,
  clearWhatsAppHold,
  trackOutcome,
  handleQualityUpdate,
  applyStatus,
};
