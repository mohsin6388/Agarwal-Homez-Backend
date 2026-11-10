/**
 * Loop guard — stops the AI from endlessly replying to another bot/auto-responder
 * (or to a flooding sender) on WhatsApp.
 *
 * Runs BEFORE any AI call or fallback send, so a looping chat costs ~nothing.
 * When tripped, the conversation is switched to `manual` (the same state as
 * "Take Over Chat"), flagged with aiBlockedReason, and the broker is notified.
 * The existing "Resume AI" button hands it back to the AI.
 *
 * All thresholds can be tuned from .env (see defaults below).
 */
const Message = require("../../models/Message");
const Conversation = require("../../models/Conversation");
const Notification = require("../../models/Notification");
const logger = require("../../utils/logger");
const { emitToUser } = require("../../sockets");

const num = (v, d) =>
  Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d;

function config() {
  const e = process.env;
  return {
    enabled: e.LOOP_GUARD_ENABLED !== "false",
    windowSec: num(e.LOOP_GUARD_WINDOW_SEC, 120), // burst window
    maxInboundInWindow: num(e.LOOP_GUARD_MAX_INBOUND, 6), // inbound msgs allowed in that window
    maxAiPerHour: num(e.LOOP_GUARD_MAX_AI_PER_HOUR, 25), // AI replies per conversation / hour
    maxAiPerDay: num(e.LOOP_GUARD_MAX_AI_PER_DAY, 80), // AI replies per conversation / day
    repeatCount: num(e.LOOP_GUARD_REPEAT_COUNT, 3), // same msg this many times in a row => loop
    repeatWithinMin: num(e.LOOP_GUARD_REPEAT_WITHIN_MIN, 15),
  };
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = new Set(a.split(" "));
  const tb = new Set(b.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.85;
}

/**
 * Returns { tripped: false } or { tripped: true, reason, detail }.
 * Never throws — on any internal error it fails OPEN (AI keeps working).
 */
async function check({ conversation }) {
  const cfg = config();
  if (!cfg.enabled) return { tripped: false };

  try {
    const now = Date.now();
    const cid = conversation._id;

    // 1) Inbound burst: too many messages in a short window.
    const burst = await Message.countDocuments({
      conversationId: cid,
      direction: "inbound",
      timestamp: { $gte: new Date(now - cfg.windowSec * 1000) },
    });
    if (burst >= cfg.maxInboundInWindow) {
      return {
        tripped: true,
        reason: "inbound_burst",
        detail: `${burst} messages in ${cfg.windowSec}s`,
      };
    }

    // 2) AI reply volume caps (per conversation).
    const [aiHour, aiDay] = await Promise.all([
      Message.countDocuments({
        conversationId: cid,
        direction: "outbound",
        sender: "ai",
        timestamp: { $gte: new Date(now - 60 * 60 * 1000) },
      }),
      Message.countDocuments({
        conversationId: cid,
        direction: "outbound",
        sender: "ai",
        timestamp: { $gte: new Date(now - 24 * 60 * 60 * 1000) },
      }),
    ]);
    if (aiHour >= cfg.maxAiPerHour) {
      return {
        tripped: true,
        reason: "ai_hourly_cap",
        detail: `${aiHour} AI replies in 1h`,
      };
    }
    if (aiDay >= cfg.maxAiPerDay) {
      return {
        tripped: true,
        reason: "ai_daily_cap",
        detail: `${aiDay} AI replies in 24h`,
      };
    }

    // 3) Repetition: same/similar text over and over (either side).
    const since = new Date(now - cfg.repeatWithinMin * 60 * 1000);
    const recent = await Message.find({
      conversationId: cid,
      timestamp: { $gte: since },
      sender: { $in: ["customer", "ai"] },
    })
      .sort({ timestamp: -1 })
      .limit(cfg.repeatCount * 4)
      .select("sender text")
      .lean();

    for (const side of ["customer", "ai"]) {
      const last = recent
        .filter((m) => m.sender === side)
        .slice(0, cfg.repeatCount)
        .map((m) => normalize(m.text));
      // ignore very short texts ("ok", "hi", "haan") — real users repeat those
      if (
        last.length >= cfg.repeatCount &&
        last[0].length >= 8 &&
        last.every((t) => similar(t, last[0]))
      ) {
        return {
          tripped: true,
          reason: side === "customer" ? "customer_repeating" : "ai_repeating",
          detail: `same ${side} text ${cfg.repeatCount}x in a row`,
        };
      }
    }

    return { tripped: false };
  } catch (err) {
    logger.error("[loop-guard] check failed (failing open)", {
      error: err.message,
    });
    return { tripped: false };
  }
}

/**
 * Pauses the AI for this conversation and tells the broker (once per trip).
 */
async function trip({ conversation, lead, reason, detail = "" }) {
  try {
    const res = await Conversation.updateOne(
      { _id: conversation._id, aiBlockedReason: null },
      {
        $set: {
          status: "manual",
          aiBlockedReason: reason,
          aiBlockedAt: new Date(),
        },
      },
    );
    conversation.status = "manual";
    conversation.aiBlockedReason = reason;

    logger.warn(
      `[loop-guard] AI paused for lead ${lead._id} (${lead.phone}): ${reason} ${detail}`,
    );

    if (res.modifiedCount === 1) {
      await Notification.create({
        userId: conversation.ownerId,
        type: "ai_paused_loop",
        title: `AI paused for ${lead.name || lead.phone}`,
        body: `Possible bot/auto-reply loop detected (${reason}${detail ? `: ${detail}` : ""}). Review the chat and press "Resume AI" if it's a real person.`,
        link: `/leads/${lead._id}`,
      });
      emitToUser(conversation.ownerId, "notification:new", {
        leadId: lead._id,
      });
      emitToUser(conversation.ownerId, "conversation:aiPaused", {
        conversationId: conversation._id,
        leadId: lead._id,
        reason,
      });
    }
  } catch (err) {
    logger.error("[loop-guard] trip failed", { error: err.message });
  }
}

/** True if we already sent this exact text in this conversation recently. */
async function recentlySent({
  conversationId,
  text,
  withinMs = 30 * 60 * 1000,
}) {
  const found = await Message.exists({
    conversationId,
    direction: "outbound",
    text,
    timestamp: { $gte: new Date(Date.now() - withinMs) },
  });
  return !!found;
}

module.exports = { check, trip, recentlySent, normalize };
