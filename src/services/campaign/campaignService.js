const Campaign = require("../../models/Campaign");
const EmailTemplate = require("../../models/EmailTemplate");
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const Audience = require("../../models/Audience");
const OutboundJob = require("../../models/OutboundJob");
const AuditLog = require("../../models/AuditLog");
const ApiError = require("../../utils/ApiError");
const { importLeadRows } = require("../leads/leadImportService");
const { scheduleCampaignJobs, todayIST } = require("../queue/outboundQueue");
const { emitToUser } = require("../../sockets");

const IST_OFFSET = "+05:30";

function currentTimeIST() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

function resolveSchedule(config) {
  if (config.scheduleAt) {
    const value = String(config.scheduleAt).trim();
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw ApiError.badRequest("Schedule date/time valid nahi hai. IST mein date aur time chunein.");
    }
    const scheduledDate = new Date(`${value}:00${IST_OFFSET}`);
    if (Number.isNaN(scheduledDate.getTime())) throw ApiError.badRequest("Schedule date/time valid nahi hai.");
    if (scheduledDate.getTime() <= Date.now()) throw ApiError.badRequest("Scheduled time future mein hona chahiye.");
    const [startDate, sendTime] = value.split("T");
    return { startDate, sendTime, scheduleAt: scheduledDate };
  }
  const today = todayIST();
  const startDate = config.startDate && config.startDate >= today ? config.startDate : today;
  return { startDate, sendTime: config.sendTime || currentTimeIST(), scheduleAt: null };
}

/**
 * Launches a campaign through the existing durable OutboundJob queue.
 * Saved audience support is additive; legacy leadIds and rows clients remain supported.
 */
async function launchCampaign({ ownerId, userId, ip, rows, leadIds, config }) {
  const selectedChannels = config.channels || {};
  if (!selectedChannels.whatsapp && !selectedChannels.email) {
    throw ApiError.badRequest("Kam se kam ek channel chuno.");
  }
  if (selectedChannels.whatsapp && config.optInConfirmed !== true) {
    throw ApiError.badRequest("Campaign shuru karne se pehle customer opt-in confirm karein.");
  }
  if (config.audienceId && (Array.isArray(leadIds) || (Array.isArray(rows) && rows.length))) {
    throw ApiError.badRequest("Audience ke saath leadIds ya rows mat bhejein.");
  }

  let selectedEmailTemplate = null;
  if (selectedChannels.email && config.emailTemplateId) {
    selectedEmailTemplate = await EmailTemplate.findOne({ _id: config.emailTemplateId, ownerId });
    if (!selectedEmailTemplate) throw ApiError.badRequest("Selected email template nahi mila. Template list refresh karein.");
    // Server-side saved content remains authoritative for the legacy email flow.
    config.emailSubject = String(config.emailSubject || selectedEmailTemplate.subject || "").trim().slice(0, 200);
    const isBlankTemplate = /^(blank|khali template)$/i.test(selectedEmailTemplate.name || "");
    config.emailBody = isBlankTemplate && config.emailBody ? config.emailBody : selectedEmailTemplate.body;
    config.emailImageUrl = config.emailImageUrl || selectedEmailTemplate.imageUrl || "";
    config.emailBrochureUrl = config.emailBrochureUrl || selectedEmailTemplate.brochureUrl || "";
    config.emailCtaText = config.emailCtaText || selectedEmailTemplate.ctaText || "";
    config.emailCtaUrl = config.emailCtaUrl || selectedEmailTemplate.ctaUrl || "";
  }

  let leads = [];
  let skipped = 0;
  let invalid = 0;
  let audience = null;
  if (config.audienceId) {
    audience = await Audience.findOne({ _id: config.audienceId, ownerId }).select("name leadIds").lean();
    if (!audience) throw ApiError.notFound("Selected audience nahi mila.");
    const audienceIds = [...new Set((audience.leadIds || []).map(String))];
    if (!audienceIds.length) throw ApiError.badRequest("Audience mein koi saved contact nahi hai.");
    const found = await Lead.find({ ownerId, _id: { $in: audienceIds } });
    const byId = new Map(found.map((lead) => [String(lead._id), lead]));
    leads = audienceIds.map((id) => byId.get(id)).filter(Boolean);
    skipped += audienceIds.length - leads.length;
  } else if (Array.isArray(leadIds) && leadIds.length) {
    if (new Set(leadIds.map(String)).size !== leadIds.length) {
      throw ApiError.badRequest("Selected list mein duplicate lead IDs hain.");
    }
    leads = await Lead.find({ ownerId, _id: { $in: leadIds } });
    const byId = new Map(leads.map((lead) => [String(lead._id), lead]));
    leads = leadIds.map((id) => byId.get(String(id))).filter(Boolean);
    skipped += leadIds.length - leads.length;
  } else {
    const eligible = (rows || []).some((row) =>
      (selectedChannels.whatsapp && String(row.phone || "").trim()) ||
      (selectedChannels.email && String(row.email || "").trim())
    );
    if (!eligible) throw ApiError.badRequest("Selected channel ke liye koi phone/email contact nahi mila.");
    const result = await importLeadRows(ownerId, rows || []);
    leads = result.inserted;
    skipped += result.skipped;
    invalid = result.invalid;
    if (!leads.length) throw ApiError.badRequest("Koi nayi lead insert nahi hui — saari rows duplicate ya invalid thi.");
  }

  if (!leads.length) throw ApiError.badRequest("Audience/selection se koi valid saved lead nahi mili.");
  const loadedLeads = [...leads];

  if (selectedChannels.whatsapp && !config.whatsappTemplateName) {
    throw ApiError.badRequest("Bulk WhatsApp ke liye Meta ka approved template select karein.");
  }
  if (selectedChannels.email && !selectedChannels.whatsapp && !leads.some((lead) => Boolean(lead.email))) {
    throw ApiError.badRequest("Selected leads mein valid email addresses nahi hain.");
  }
  if (selectedChannels.email && !config.emailSubject?.trim()) throw ApiError.badRequest("Email subject required.");
  if (selectedChannels.email && !config.emailBody?.trim()) throw ApiError.badRequest("Email body required.");

  // A sent job is the existing system's source of truth for already received campaign messages.
  // Keep skip decisions separate per channel so a previously messaged WhatsApp lead can still
  // receive an email in a combined legacy campaign when that email was not sent before.
  const ids = leads.map((lead) => lead._id);
  const sentSets = { whatsapp: new Set(), email: new Set() };
  if (config.skipAlreadySent && ids.length) {
    const checks = [];
    for (const channel of ["whatsapp", "email"]) {
      if (!selectedChannels[channel]) continue;
      checks.push(OutboundJob.find({ ownerId, leadId: { $in: ids }, channel, status: "sent" }).distinct("leadId").then((sentIds) => {
        sentSets[channel] = new Set(sentIds.map(String));
      }));
    }
    await Promise.all(checks);
  }

  let skippedAlreadySent = 0;
  const enrichedLeads = leads.map((lead) => ({
    ...lead.toObject(),
    _id: lead._id,
    hasPhone: Boolean(lead.phone),
    hasEmail: Boolean(lead.email),
    skipWhatsapp: Boolean(config.skipAlreadySent && sentSets.whatsapp.has(String(lead._id))),
    skipEmail: Boolean(lead.emailOptOut || (config.skipAlreadySent && sentSets.email.has(String(lead._id)))),
  }));
  const eligibleLeads = enrichedLeads.filter((lead) => {
    const hadSelectedContact = (selectedChannels.whatsapp && lead.hasPhone) || (selectedChannels.email && lead.hasEmail);
    const hasUnsentSelectedChannel = (selectedChannels.whatsapp && lead.hasPhone && !lead.skipWhatsapp) ||
      (selectedChannels.email && lead.hasEmail && !lead.skipEmail);
    if (hadSelectedContact && !hasUnsentSelectedChannel) skippedAlreadySent += 1;
    return hasUnsentSelectedChannel;
  });
  skipped += skippedAlreadySent;

  if (!eligibleLeads.length) {
    throw ApiError.badRequest(config.skipAlreadySent
      ? "Is audience ke saare eligible contacts ko selected channel par pehle message bheja ja chuka hai. Skip option band karke preview karein."
      : "Selected channel ke liye valid contact fields nahi mile.");
  }

  if (selectedChannels.whatsapp && !eligibleLeads.some((lead) => lead.hasPhone && !lead.skipWhatsapp) && !selectedChannels.email) {
    throw ApiError.badRequest("Selected audience mein send karne layak WhatsApp numbers nahi hain.");
  }

  const conversationLeads = eligibleLeads.filter((lead) => Boolean(lead.phone) && selectedChannels.whatsapp && !lead.skipWhatsapp);
  if (conversationLeads.length) {
    await Conversation.bulkWrite(conversationLeads.map((lead) => ({
      updateOne: {
        filter: { ownerId, leadId: lead._id },
        update: { $setOnInsert: { ownerId, leadId: lead._id } },
        upsert: true,
      },
    })), { ordered: false });
  }

  const schedule = resolveSchedule(config);
  const campaign = await Campaign.create({
    ownerId,
    name: config.name,
    channels: selectedChannels,
    dailyLimit: Math.max(1, Math.min(20000, Number(config.dailyLimit) || 5000)),
    sendTime: schedule.sendTime,
    startDate: schedule.startDate,
    scheduleAt: schedule.scheduleAt,
    audienceId: audience?._id || null,
    skipAlreadySent: Boolean(config.skipAlreadySent),
    optInConfirmed: Boolean(config.optInConfirmed),
    optInConfirmedAt: selectedChannels.whatsapp && config.optInConfirmed ? new Date() : null,
    whatsappTemplate: selectedChannels.whatsapp ? {
      name: config.whatsappTemplateName,
      language: config.whatsappTemplateLanguage || "en_US",
      category: config.whatsappTemplateCategory || "",
      variables: Array.isArray(config.whatsappTemplateVariables) ? config.whatsappTemplateVariables : [],
      headerType: config.whatsappTemplateHeaderType || (config.whatsappTemplateHeaderImageUrl ? "image" : "none"),
      headerImageUrl: config.whatsappTemplateHeaderImageUrl || "",
      headerDocumentUrl: config.whatsappTemplateHeaderDocumentUrl || "",
      body: config.whatsappTemplateBody || "",
    } : undefined,
    email: {
      templateId: selectedEmailTemplate?._id || null,
      templateName: selectedEmailTemplate?.name || "",
      subject: config.emailSubject || "",
      body: config.emailBody || "",
      imageUrl: config.emailImageUrl || "",
      brochureUrl: config.emailBrochureUrl || "",
      ctaText: config.emailCtaText || "",
      ctaUrl: config.emailCtaUrl || "",
    },
    totalLeads: eligibleLeads.length,
  });

  const plan = await scheduleCampaignJobs({
    campaign,
    leads: eligibleLeads.map((lead) => ({
      _id: lead._id,
      hasPhone: Boolean(lead.phone),
      hasEmail: Boolean(lead.email),
      skipWhatsapp: Boolean(lead.skipWhatsapp),
      skipEmail: Boolean(lead.skipEmail),
      email: lead.email || "",
      name: lead.name || "",
    })),
  });

  campaign.leadsWithoutEmail = selectedChannels.email ? eligibleLeads.filter((lead) => !lead.email || lead.skipEmail).length : 0;
  campaign.totalDays = plan.totalDays;
  campaign.firstRunAt = plan.firstRunAt;
  campaign.lastRunAt = plan.lastRunAt;
  await campaign.save();

  await AuditLog.create({
    userId,
    action: "campaign.launch",
    entityType: "Campaign",
    entityId: campaign._id,
    meta: {
      leads: eligibleLeads.length,
      audienceId: audience?._id ? String(audience._id) : null,
      selectedLeadIds: Array.isArray(leadIds) ? leadIds.length : 0,
      skipped,
      invalid,
      skipAlreadySent: Boolean(config.skipAlreadySent),
      optInConfirmed: Boolean(config.optInConfirmed),
      scheduleAt: schedule.scheduleAt,
      channels: selectedChannels,
      dailyLimit: campaign.dailyLimit,
      sendTime: schedule.sendTime,
      whatsappTemplateName: config.whatsappTemplateName || null,
    },
    ip,
  });

  emitToUser(ownerId, "outreach:campaign", { campaignId: String(campaign._id), status: "active" });

  return {
    campaign,
    insertedCount: eligibleLeads.length,
    skipped,
    invalid,
    queued: { whatsapp: plan.whatsapp, email: plan.email },
    withoutEmail: campaign.leadsWithoutEmail,
    withoutPhone: loadedLeads.filter((lead) => !lead.phone).length,
    whatsappAvailable: loadedLeads.filter((lead) => Boolean(lead.phone)).length,
    emailAvailable: loadedLeads.filter((lead) => Boolean(lead.email)).length,
    totalDays: plan.totalDays,
    firstRunAt: plan.firstRunAt,
    lastRunAt: plan.lastRunAt,
  };
}

module.exports = { launchCampaign, currentTimeIST, resolveSchedule };
