const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const LeadScore = require('../../models/LeadScore');
const FollowUp = require('../../models/FollowUp');
const Notification = require('../../models/Notification');

const settingsService = require('../settings/settingsService');
const { generateStructured } = require('./geminiClient');
const { emitToUser } = require('../../sockets');
const logger = require('../../utils/logger');

const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '0-100 lead quality score' },
    level: { type: 'string', enum: ['cold', 'warm', 'hot'] },
    interestLevel: { type: 'string' },
    buyingIntent: { type: 'string' },
    budgetMatch: { type: 'boolean' },
    closingProbability: { type: 'number', description: '0-100' },
    summary: { type: 'string', description: '2-3 sentence summary of the buyer and where the conversation stands.' },
    reason: { type: 'string', description: 'Why this score was given.' },
    nextFollowUpDate: { type: 'string', description: 'ISO date (YYYY-MM-DD) for the next follow-up.' },
    nextFollowUpMessage: { type: 'string', description: 'A draft opening line for the next follow-up message.' },
    urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
    buyingProbability: { type: 'number', description: '0-100' },
  },
  required: ['score', 'level', 'summary', 'reason', 'nextFollowUpDate', 'nextFollowUpMessage', 'urgency'],
};

function buildAnalysisPrompt(lead) {
  return `You are a real estate sales analyst reviewing a WhatsApp conversation between a sales executive and a buyer named ${lead.name}.

Read the full conversation history and return a structured analysis:
- A lead quality score (0-100) and level (cold/warm/hot) based on genuine buying signals, not politeness.
- Their real interest level and buying intent.
- Whether their budget realistically matches what's being discussed.
- A closing probability (0-100).
- A short summary and the reasoning behind your score.
- A sensible next follow-up date (consider urgency — hot leads get followed up sooner, within 1-2 days; cold leads can wait longer) and a natural draft opening line for that follow-up.
- Urgency level and an overall buying probability.

Be realistic and conservative — don't inflate scores just because the buyer was polite.`;
}

/** Runs one full-conversation analysis pass and persists the results. Safe to call repeatedly (append-only history + idempotent upserts). */
async function analyzeConversationAsync({ leadId, conversationId }) {
  const apiKey = await settingsService.getGeminiKey();
  if (!apiKey) return; // no key configured — scoring simply doesn't run yet

  const [lead, messages] = await Promise.all([
    Lead.findById(leadId),
    Message.find({ conversationId }).sort({ timestamp: 1 }).limit(60).lean(),
  ]);
  if (!lead || !messages.length) return;

  const transcript = messages
    .map((m) => `${m.direction === 'inbound' ? 'Buyer' : 'Sales Exec'}: ${m.text}`)
    .join('\n');

  let parsed;
  try {
    ({ parsed } = await generateStructured({
      apiKey,
      systemInstruction: buildAnalysisPrompt(lead),
      history: [{ role: 'user', text: transcript }],
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      temperature: 0.3, // scoring should be consistent, not creative
    }));
  } catch (err) {
    logger.error(`[ai] Lead analysis Gemini call failed for lead ${leadId}`, { error: err.message });
    return;
  }

  const score = clamp(parsed.score, 0, 100);

  await LeadScore.create({
    leadId,
    score,
    level: parsed.level,
    interestLevel: parsed.interestLevel || null,
    buyingIntent: parsed.buyingIntent || null,
    budgetMatch: parsed.budgetMatch ?? null,
    closingProbability: parsed.closingProbability != null ? clamp(parsed.closingProbability, 0, 100) : null,
    summary: parsed.summary,
    reason: parsed.reason,
  });

  const wasHotBefore = lead.status === 'hot';
  lead.leadScore = score;
  // Only auto-promote status via score for leads still in the AI-qualification
  // funnel — never downgrade/override a broker's manual closed/lost/site_visit call.
  if (!['closed', 'lost', 'site_visit'].includes(lead.status)) {
    lead.status = parsed.level; // 'cold' | 'warm' | 'hot' — all valid Lead.STATUSES values
  }
  await lead.save();

  await Conversation.updateOne(
    { _id: conversationId },
    { $set: { aiSummary: parsed.summary, currentLeadScore: score } }
  );

  if (parsed.nextFollowUpDate) {
    await FollowUp.findOneAndUpdate(
      { leadId, status: 'pending' },
      {
        leadId,
        ownerId: lead.ownerId,
        nextFollowUpDate: new Date(parsed.nextFollowUpDate),
        nextFollowUpMessage: parsed.nextFollowUpMessage,
        urgency: parsed.urgency || 'medium',
        buyingProbability: parsed.buyingProbability != null ? clamp(parsed.buyingProbability, 0, 100) : null,
        status: 'pending',
        generatedBy: 'gemini',
      },
      { upsert: true, new: true }
    );
  }

  if (parsed.level === 'hot' && !wasHotBefore) {
    await Notification.create({
      userId: lead.ownerId,
      type: 'hot_lead',
      title: `🔥 Hot lead — ${lead.name}`,
      body: parsed.summary,
      link: `/leads/${lead._id}`,
    });
  }

  emitToUser(lead.ownerId, 'lead:scored', { leadId, score, level: parsed.level });
}

function clamp(n, min, max) {
  if (typeof n !== 'number' || Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

module.exports = { analyzeConversationAsync };
