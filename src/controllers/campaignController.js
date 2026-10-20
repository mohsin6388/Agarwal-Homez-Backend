// const asyncHandler = require("../utils/asyncHandler");
// const ApiError = require("../utils/ApiError");
// const ApiResponse = require("../utils/ApiResponse");
// const Campaign = require("../models/Campaign");
// const EmailMessage = require("../models/EmailMessage");
// const Audience = require("../models/Audience");
// const Lead = require("../models/Lead");
// const OutboundJob = require("../models/OutboundJob");
// const Settings = require("../models/Settings");
// const AuditLog = require("../models/AuditLog");
// const settingsService = require("../services/settings/settingsService");
// const metaWhatsappClient = require("../services/whatsapp/metaWhatsappClient");
// const {
//   buildTemplateComponents,
//   getWhatsAppRate,
// } = require("../services/campaign/templateVariableResolver");
// const { launchCampaign } = require("../services/campaign/campaignService");
// const queue = require("../services/queue/outboundQueue");
// const { emitToUser } = require("../sockets");

// /** POST /api/campaigns/launch */
// const launch = asyncHandler(async (req, res) => {
//   const { rows, leadIds, ...config } = req.body;

//   const result = await launchCampaign({
//     ownerId: req.user.id,
//     userId: req.user.id,
//     ip: req.ip,
//     rows,
//     leadIds,
//     config,
//   });

//   const { whatsapp, email } = result.queued;
//   const parts = [];
//   if (whatsapp) parts.push(`${whatsapp} WhatsApp`);
//   if (email) parts.push(`${email} email`);

//   return new ApiResponse(
//     201,
//     {
//       campaignId: result.campaign._id,
//       insertedCount: result.insertedCount,
//       skipped: result.skipped,
//       invalid: result.invalid,
//       queued: result.queued,
//       withoutEmail: result.withoutEmail,
//       withoutPhone: result.withoutPhone,
//       whatsappAvailable: result.whatsappAvailable,
//       emailAvailable: result.emailAvailable,
//       totalDays: result.totalDays,
//       firstRunAt: result.firstRunAt,
//       lastRunAt: result.lastRunAt,
//     },
//     `Campaign started: ${result.insertedCount} leads, ${parts.join(" + ")} scheduled over ${result.totalDays} day(s).`,
//   ).send(res);
// });

// /** POST /api/campaigns/preview — no sends or jobs are created; accepts an audience or selected lead IDs. */
// const preview = asyncHandler(async (req, res) => {
//   const {
//     audienceId,
//     leadIds,
//     channel = "whatsapp",
//     skipAlreadySent = true,
//     category = "MARKETING",
//   } = req.body;
//   let ids = [];
//   if (audienceId) {
//     const audience = await Audience.findOne({
//       _id: audienceId,
//       ownerId: req.user.id,
//     })
//       .select("leadIds")
//       .lean();
//     if (!audience) throw ApiError.notFound("Selected audience nahi mila.");
//     ids = [...new Set((audience.leadIds || []).map(String))];
//   } else if (Array.isArray(leadIds)) {
//     ids = [...new Set(leadIds.map(String))];
//   }
//   if (!ids.length)
//     throw ApiError.badRequest(
//       "Audience/selection mein koi saved contact nahi hai.",
//     );

//   const leads = await Lead.find({ ownerId: req.user.id, _id: { $in: ids } })
//     .select("_id phone email emailOptOut")
//     .lean();
//   const byId = new Map(leads.map((lead) => [String(lead._id), lead]));
//   const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
//   const hasContact = (lead) =>
//     channel === "whatsapp"
//       ? Boolean(String(lead.phone || "").trim())
//       : Boolean(String(lead.email || "").trim()) && !lead.emailOptOut;
//   const valid = ordered.filter(hasContact);
//   let sentSet = new Set();
//   if (skipAlreadySent && valid.length) {
//     const sentIds = await OutboundJob.find({
//       ownerId: req.user.id,
//       leadId: { $in: valid.map((lead) => lead._id) },
//       channel,
//       status: "sent",
//     }).distinct("leadId");
//     sentSet = new Set(sentIds.map(String));
//   }
//   const skip = skipAlreadySent
//     ? valid.filter((lead) => sentSet.has(String(lead._id))).length
//     : 0;
//   const final = Math.max(0, valid.length - skip);
//   const missingContact = Math.max(0, ids.length - valid.length);
//   const settings = await Settings.findOne({}).lean();
//   const rateInr =
//     channel === "whatsapp" ? getWhatsAppRate(settings, category) : null;
//   return new ApiResponse(
//     200,
//     {
//       total: ids.length,
//       skip,
//       final,
//       missingContact,
//       rateInr,
//       estimatedCostInr:
//         rateInr === null ? null : Number((rateInr * final).toFixed(2)),
//       category: String(category).toUpperCase(),
//       channel,
//     },
//     "Campaign preview ready",
//   ).send(res);
// });

// /** POST /api/campaigns/test-send — send the selected approved template to one test phone. */
// const testSend = asyncHandler(async (req, res) => {
//   const body = req.body || {};
//   let ids = [];
//   let audience = null;
//   if (body.audienceId) {
//     audience = await Audience.findOne({
//       _id: body.audienceId,
//       ownerId: req.user.id,
//     })
//       .select("leadIds")
//       .lean();
//     if (!audience) throw ApiError.notFound("Selected audience nahi mila.");
//     ids = [...new Set((audience.leadIds || []).map(String))];
//   } else if (Array.isArray(body.leadIds)) {
//     ids = [...new Set(body.leadIds.map(String))];
//   }
//   const leads = await Lead.find({
//     ownerId: req.user.id,
//     _id: { $in: ids },
//     phone: { $type: "string", $ne: "" },
//   }).lean();
//   const byId = new Map(leads.map((lead) => [String(lead._id), lead]));
//   const sampleLead = ids.map((id) => byId.get(id)).find(Boolean);
//   if (!sampleLead)
//     throw ApiError.badRequest(
//       "Selected recipients mein WhatsApp number wala sample contact nahi mila.",
//     );

//   const settings = await settingsService.getOrCreateSettings();
//   if (settings.whatsappDisconnected)
//     throw ApiError.badRequest(
//       "WhatsApp disconnected hai. Pehle Settings se reconnect karein.",
//     );
//   const components = buildTemplateComponents({
//     variables: body.whatsappTemplateVariables || [],
//     lead: sampleLead,
//     headerType: body.whatsappTemplateHeaderType || "none",
//     headerImageUrl: body.whatsappTemplateHeaderImageUrl || "",
//     headerDocumentUrl: body.whatsappTemplateHeaderDocumentUrl || "",
//   });
//   const result = await metaWhatsappClient.sendTemplateMessage({
//     phone: body.phone,
//     templateName: body.whatsappTemplateName,
//     languageCode: body.whatsappTemplateLanguage || "en_US",
//     components,
//   });
//   await AuditLog.create({
//     userId: req.user.id,
//     action: "campaign.test_send",
//     entityType: "Campaign",
//     meta: {
//       audienceId: audience?._id ? String(audience._id) : null,
//       selectedLeadCount: ids.length,
//       templateName: body.whatsappTemplateName,
//       messageId: result.messageId || null,
//     },
//     ip: req.ip,
//   });
//   return new ApiResponse(
//     200,
//     { messageId: result.messageId || null },
//     "Test WhatsApp template bhej diya gaya.",
//   ).send(res);
// });

// /** GET /api/campaigns */
// const list = asyncHandler(async (req, res) => {
//   const campaigns = await queue.listCampaigns(req.user.id, { limit: 30 });
//   return new ApiResponse(200, { campaigns }).send(res);
// });

// /** GET /api/campaigns/:id */
// const getOne = asyncHandler(async (req, res) => {
//   const campaign = await Campaign.findOne({
//     _id: req.params.id,
//     ownerId: req.user.id,
//   }).lean();
//   if (!campaign) throw ApiError.notFound("Campaign not found");
//   const stats = await queue.getCampaignStats(campaign._id);
//   return new ApiResponse(200, { campaign: { ...campaign, stats } }).send(res);
// });

// function control(action, message) {
//   return asyncHandler(async (req, res) => {
//     const result = await action(req);
//     if (!result) throw ApiError.notFound("Campaign not found");

//     if (message === "Campaign cancelled") {
//       await EmailMessage.updateMany(
//         {
//           ownerId: req.user.id,
//           campaignId: result.campaign._id,
//           direction: "outbound",
//           kind: "campaign",
//           status: { $in: ["queued", "sending"] },
//         },
//         { $set: { status: "cancelled" } },
//       );
//     }

//     const stats = await queue.getCampaignStats(result.campaign._id);
//     emitToUser(req.user.id, "outreach:campaign", {
//       campaignId: String(result.campaign._id),
//       status: result.campaign.status,
//     });
//     emitToUser(req.user.id, "outreach:progress", {
//       campaignId: String(result.campaign._id),
//       stats,
//     });

//     return new ApiResponse(
//       200,
//       { status: result.campaign.status, affected: result.modified, stats },
//       `${message}: ${result.modified} job(s)`,
//     ).send(res);
//   });
// }

// const pause = control(
//   (req) => queue.pauseCampaign(req.user.id, req.params.id),
//   "Campaign paused",
// );
// const resume = control(
//   (req) => queue.resumeCampaign(req.user.id, req.params.id),
//   "Campaign resumed",
// );
// const cancel = control(
//   (req) => queue.cancelCampaign(req.user.id, req.params.id),
//   "Campaign cancelled",
// );
// const retry = control(
//   (req) => queue.retryFailed(req.user.id, req.params.id, req.body?.channel),
//   "Failed jobs re-queued",
// );

// /** GET /api/outreach/summary — sidebar badges + page header cards */
// const summary = asyncHandler(async (req, res) => {
//   const data = await queue.getOutreachSummary(req.user.id);
//   return new ApiResponse(200, data).send(res);
// });

// /** GET /api/outreach/jobs?channel=&campaignId=&status=&page= */
// const jobs = asyncHandler(async (req, res) => {
//   const data = await queue.listJobs(req.user.id, req.query);
//   return new ApiResponse(200, data).send(res);
// });

// module.exports = {
//   launch,
//   preview,
//   testSend,
//   list,
//   getOne,
//   pause,
//   resume,
//   cancel,
//   retry,
//   summary,
//   jobs,
// };

const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");

const Campaign = require("../models/Campaign");
const EmailMessage = require("../models/EmailMessage");
const Audience = require("../models/Audience");
const Lead = require("../models/Lead");
const OutboundJob = require("../models/OutboundJob");
const Settings = require("../models/Settings");
const AuditLog = require("../models/AuditLog");

const settingsService = require("../services/settings/settingsService");
const metaWhatsappClient = require("../services/whatsapp/metaWhatsappClient");

const {
  buildTemplateComponents,
  getWhatsAppRate,
} = require("../services/campaign/templateVariableResolver");

const { launchCampaign } = require("../services/campaign/campaignService");
const queue = require("../services/queue/outboundQueue");
const { emitToUser } = require("../sockets");

/**
 * POST /api/campaigns/launch
 * Launch campaign using uploaded rows, selected lead IDs,
 * or a saved audience.
 */
const launch = asyncHandler(async (req, res) => {
  const {
    rows,
    leadIds,
    audienceId,
    skipAlreadySent = false,
    ...restConfig
  } = req.body;

  let resolvedLeadIds = leadIds;

  // Resolve leads from a saved audience.
  if (audienceId) {
    const audience = await Audience.findOne({
      _id: audienceId,
      ownerId: req.user.id,
    })
      .select("leadIds")
      .lean();

    if (!audience) {
      throw ApiError.notFound("Selected audience nahi mila.");
    }

    resolvedLeadIds = [...new Set((audience.leadIds || []).map(String))];

    if (!resolvedLeadIds.length) {
      throw ApiError.badRequest(
        "Selected audience mein saved contacts nahi hain.",
      );
    }
  }

  // Exclude contacts who have already received a WhatsApp message.
  if (
    skipAlreadySent &&
    Array.isArray(resolvedLeadIds) &&
    resolvedLeadIds.length
  ) {
    const sentIds = await OutboundJob.find({
      ownerId: req.user.id,
      leadId: { $in: resolvedLeadIds },
      channel: "whatsapp",
      status: "sent",
    }).distinct("leadId");

    const sentSet = new Set(sentIds.map(String));

    resolvedLeadIds = resolvedLeadIds.filter((id) => !sentSet.has(String(id)));

    if (!resolvedLeadIds.length) {
      throw ApiError.badRequest(
        "Selected contacts ko pehle hi WhatsApp message bheja ja chuka hai.",
      );
    }
  }

  const config = {
    ...restConfig,
    skipAlreadySent,
  };

  const result = await launchCampaign({
    ownerId: req.user.id,
    userId: req.user.id,
    ip: req.ip,
    rows: audienceId ? undefined : rows,
    leadIds: resolvedLeadIds,
    config,
  });

  const { whatsapp, email } = result.queued;
  const parts = [];

  if (whatsapp) parts.push(`${whatsapp} WhatsApp`);
  if (email) parts.push(`${email} email`);

  return new ApiResponse(
    201,
    {
      campaignId: result.campaign._id,
      insertedCount: result.insertedCount,
      skipped: result.skipped,
      invalid: result.invalid,
      queued: result.queued,
      withoutEmail: result.withoutEmail,
      withoutPhone: result.withoutPhone,
      whatsappAvailable: result.whatsappAvailable,
      emailAvailable: result.emailAvailable,
      totalDays: result.totalDays,
      firstRunAt: result.firstRunAt,
      lastRunAt: result.lastRunAt,
    },
    `Campaign started: ${result.insertedCount} leads, ${parts.join(
      " + ",
    )} scheduled over ${result.totalDays} day(s).`,
  ).send(res);
});

/** DELETE /api/campaigns/:id */
const remove = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    ownerId: req.user.id,
  });

  if (!campaign) {
    throw ApiError.notFound("Campaign not found");
  }

  // Active ya paused campaign ko pehle cancel karna zaroori hai.
  if (["active", "paused"].includes(campaign.status)) {
    throw ApiError.badRequest("Please cancel the campaign before deleting it.");
  }

  // Processing job ke dauran delete mat karo.
  const processingJobs = await OutboundJob.countDocuments({
    ownerId: req.user.id,
    campaignId: campaign._id,
    status: "processing",
  });

  if (processingJobs > 0) {
    throw ApiError.badRequest(
      "Campaign has jobs being processed. Please try again later.",
    );
  }

  // Campaign ke associated records remove karo.
  await OutboundJob.deleteMany({
    ownerId: req.user.id,
    campaignId: campaign._id,
  });

  await EmailMessage.deleteMany({
    ownerId: req.user.id,
    campaignId: campaign._id,
    direction: "outbound",
    kind: "campaign",
  });

  await campaign.deleteOne();

  return new ApiResponse(
    200,
    { campaignId: String(campaign._id) },
    "Campaign deleted successfully.",
  ).send(res);
});

/**
 * POST /api/campaigns/preview
 * Preview selected contacts or a saved audience without sending messages.
 */
const preview = asyncHandler(async (req, res) => {
  const {
    audienceId,
    leadIds,
    channel = "whatsapp",
    skipAlreadySent = true,
    category = "MARKETING",
  } = req.body;

  let ids = [];

  if (audienceId) {
    const audience = await Audience.findOne({
      _id: audienceId,
      ownerId: req.user.id,
    })
      .select("leadIds")
      .lean();

    if (!audience) {
      throw ApiError.notFound("Selected audience nahi mila.");
    }

    ids = [...new Set((audience.leadIds || []).map(String))];
  } else if (Array.isArray(leadIds)) {
    ids = [...new Set(leadIds.map(String))];
  }

  if (!ids.length) {
    throw ApiError.badRequest(
      "Audience/selection mein koi saved contact nahi hai.",
    );
  }

  const leads = await Lead.find({
    ownerId: req.user.id,
    _id: { $in: ids },
  })
    .select("_id phone email emailOptOut")
    .lean();

  const byId = new Map(leads.map((lead) => [String(lead._id), lead]));

  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

  const hasContact = (lead) => {
    if (channel === "whatsapp") {
      return Boolean(String(lead.phone || "").trim());
    }

    return Boolean(String(lead.email || "").trim()) && !lead.emailOptOut;
  };

  const valid = ordered.filter(hasContact);

  let sentSet = new Set();

  if (skipAlreadySent && valid.length) {
    const sentIds = await OutboundJob.find({
      ownerId: req.user.id,
      leadId: { $in: valid.map((lead) => lead._id) },
      channel,
      status: "sent",
    }).distinct("leadId");

    sentSet = new Set(sentIds.map(String));
  }

  const skip = skipAlreadySent
    ? valid.filter((lead) => sentSet.has(String(lead._id))).length
    : 0;

  const final = Math.max(0, valid.length - skip);
  const missingContact = Math.max(0, ids.length - valid.length);

  const settings = await Settings.findOne({}).lean();

  const rateInr =
    channel === "whatsapp" ? getWhatsAppRate(settings, category) : null;

  return new ApiResponse(
    200,
    {
      total: ids.length,
      skip,
      final,
      missingContact,
      rateInr,
      estimatedCostInr:
        rateInr === null ? null : Number((rateInr * final).toFixed(2)),
      category: String(category).toUpperCase(),
      channel,
    },
    "Campaign preview ready",
  ).send(res);
});

/**
 * POST /api/campaigns/test-send
 * Send the approved template to the specified test phone.
 */
const testSend = asyncHandler(async (req, res) => {
  const body = req.body || {};

  let ids = [];
  let audience = null;

  if (body.audienceId) {
    audience = await Audience.findOne({
      _id: body.audienceId,
      ownerId: req.user.id,
    })
      .select("leadIds")
      .lean();

    if (!audience) {
      throw ApiError.notFound("Selected audience nahi mila.");
    }

    ids = [...new Set((audience.leadIds || []).map(String))];
  } else if (Array.isArray(body.leadIds)) {
    ids = [...new Set(body.leadIds.map(String))];
  }

  const leads = await Lead.find({
    ownerId: req.user.id,
    _id: { $in: ids },
    phone: { $type: "string", $ne: "" },
  }).lean();

  const byId = new Map(leads.map((lead) => [String(lead._id), lead]));

  const sampleLead = ids.map((id) => byId.get(id)).find(Boolean);

  if (!sampleLead) {
    throw ApiError.badRequest(
      "Selected recipients mein WhatsApp number wala sample contact nahi mila.",
    );
  }

  const settings = await settingsService.getOrCreateSettings();

  if (settings.whatsappDisconnected) {
    throw ApiError.badRequest(
      "WhatsApp disconnected hai. Pehle Settings se reconnect karein.",
    );
  }

  const components = buildTemplateComponents({
    variables: body.whatsappTemplateVariables || [],
    lead: sampleLead,
    headerType: body.whatsappTemplateHeaderType || "none",
    headerImageUrl: body.whatsappTemplateHeaderImageUrl || "",
    headerDocumentUrl: body.whatsappTemplateHeaderDocumentUrl || "",
  });

  const result = await metaWhatsappClient.sendTemplateMessage({
    phone: body.phone,
    templateName: body.whatsappTemplateName,
    languageCode: body.whatsappTemplateLanguage || "en_US",
    components,
  });

  await AuditLog.create({
    userId: req.user.id,
    action: "campaign.test_send",
    entityType: "Campaign",
    meta: {
      audienceId: audience?._id ? String(audience._id) : null,
      selectedLeadCount: ids.length,
      templateName: body.whatsappTemplateName,
      messageId: result.messageId || null,
    },
    ip: req.ip,
  });

  return new ApiResponse(
    200,
    { messageId: result.messageId || null },
    "Test WhatsApp template bhej diya gaya.",
  ).send(res);
});

/** GET /api/campaigns */
const list = asyncHandler(async (req, res) => {
  const campaigns = await queue.listCampaigns(req.user.id, {
    limit: 30,
  });

  return new ApiResponse(200, { campaigns }).send(res);
});

/** GET /api/campaigns/:id */
const getOne = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    ownerId: req.user.id,
  }).lean();

  if (!campaign) {
    throw ApiError.notFound("Campaign not found");
  }

  const stats = await queue.getCampaignStats(campaign._id);

  return new ApiResponse(200, { campaign: { ...campaign, stats } }).send(res);
});

function control(action, message) {
  return asyncHandler(async (req, res) => {
    const result = await action(req);

    if (!result) {
      throw ApiError.notFound("Campaign not found");
    }

    if (message === "Campaign cancelled") {
      await EmailMessage.updateMany(
        {
          ownerId: req.user.id,
          campaignId: result.campaign._id,
          direction: "outbound",
          kind: "campaign",
          status: { $in: ["queued", "sending"] },
        },
        {
          $set: { status: "cancelled" },
        },
      );
    }

    const stats = await queue.getCampaignStats(result.campaign._id);

    emitToUser(req.user.id, "outreach:campaign", {
      campaignId: String(result.campaign._id),
      status: result.campaign.status,
    });

    emitToUser(req.user.id, "outreach:progress", {
      campaignId: String(result.campaign._id),
      stats,
    });

    return new ApiResponse(
      200,
      {
        status: result.campaign.status,
        affected: result.modified,
        stats,
      },
      `${message}: ${result.modified} job(s)`,
    ).send(res);
  });
}

const pause = control(
  (req) => queue.pauseCampaign(req.user.id, req.params.id),
  "Campaign paused",
);

const resume = control(
  (req) => queue.resumeCampaign(req.user.id, req.params.id),
  "Campaign resumed",
);

const cancel = control(
  (req) => queue.cancelCampaign(req.user.id, req.params.id),
  "Campaign cancelled",
);

const retry = control(
  (req) => queue.retryFailed(req.user.id, req.params.id, req.body?.channel),
  "Failed jobs re-queued",
);

/** GET /api/outreach/summary */
const summary = asyncHandler(async (req, res) => {
  const data = await queue.getOutreachSummary(req.user.id);

  return new ApiResponse(200, data).send(res);
});

/** GET /api/outreach/jobs */
const jobs = asyncHandler(async (req, res) => {
  const data = await queue.listJobs(req.user.id, req.query);

  return new ApiResponse(200, data).send(res);
});

module.exports = {
  launch,
  preview,
  testSend,
  list,
  getOne,
  pause,
  resume,
  remove,
  cancel,
  retry,
  summary,
  jobs,
};
