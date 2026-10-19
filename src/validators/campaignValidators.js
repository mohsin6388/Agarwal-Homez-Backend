const { z } = require("zod");
const { importRowSchema } = require("./leadValidators");

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

const launchCampaignSchema = z.object({
  body: z.object({
    rows: z.array(importRowSchema).min(1).max(20000).optional(),
    leadIds: z.array(objectId).min(1).max(20000).optional(),
    audienceId: objectId.optional(),
    skipAlreadySent: z.boolean().optional().default(false),
    optInConfirmed: z.boolean().optional().default(false),
    scheduleAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/, "scheduleAt must be YYYY-MM-DDTHH:mm in IST").optional(),
    name: z.string().trim().min(1, "Campaign name required").max(120),
    channels: z.object({ whatsapp: z.boolean(), email: z.boolean() }).refine((c) => c.whatsapp || c.email, "Kam se kam ek channel chuno"),
    dailyLimit: z.number().int().min(1).max(20000).default(5000),
    sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "sendTime must be HH:mm").default("10:00"),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    emailTemplateId: objectId.optional(),
    emailSubject: z.string().trim().max(200).optional().default(""),
    emailBody: z.string().trim().max(5000).optional().default(""),
    emailImageUrl: z.string().url().max(2000).optional().or(z.literal("")).default(""),
    emailBrochureUrl: z.string().url().max(2000).optional().or(z.literal("")).default(""),
    emailCtaText: z.string().trim().max(40).optional().default(""),
    emailCtaUrl: z.string().url().max(2000).optional().or(z.literal("")).default(""),
    whatsappTemplateName: z.string().trim().max(200).optional().default(""),
    whatsappTemplateLanguage: z.string().trim().max(30).optional().default("en_US"),
    whatsappTemplateCategory: z.string().trim().max(40).optional().default(""),
    whatsappTemplateHeaderImageUrl: z.string().url().max(2000).optional().or(z.literal("")).default(""),
    whatsappTemplateHeaderType: z.enum(["none", "text", "image", "document", "pdf", "brochure"]).optional().default("none"),
    whatsappTemplateHeaderDocumentUrl: z.string().url().max(2000).optional().or(z.literal("")).default(""),
    whatsappTemplateBody: z.string().trim().max(1024).optional().default(""),
    whatsappTemplateVariables: z.array(z.object({
      index: z.number().int().min(1).max(10),
      source: z.enum(["name", "phone", "email", "city", "budget", "static"]),
      value: z.string().max(1000).optional().default(""),
      fallback: z.string().max(200).optional().default("Sir/Ma’am"),
    })).max(10).optional().default([]),
  }).superRefine((b, ctx) => {
    if (!b.rows?.length && !b.leadIds?.length && !b.audienceId) {
      ctx.addIssue({ code: "custom", path: ["audienceId"], message: "Saved audience ya selected leads choose karein." });
    }
    if ([Boolean(b.rows?.length), Boolean(b.leadIds?.length), Boolean(b.audienceId)].filter(Boolean).length > 1) {
      ctx.addIssue({ code: "custom", path: ["audienceId"], message: "Campaign mein audience, lead IDs, ya rows mein se sirf ek input use karein." });
    }
    if (b.channels.whatsapp && b.optInConfirmed !== true) {
      ctx.addIssue({ code: "custom", path: ["optInConfirmed"], message: "WhatsApp campaign se pehle opt-in confirm karna zaroori hai." });
    }
    if (b.channels.email && !b.emailTemplateId) {
      if (!b.emailSubject) ctx.addIssue({ code: "custom", path: ["emailSubject"], message: "Email subject required" });
      if (!b.emailBody) ctx.addIssue({ code: "custom", path: ["emailBody"], message: "Email body required" });
    }
    if (b.channels.whatsapp && !b.whatsappTemplateName) {
      ctx.addIssue({ code: "custom", path: ["whatsappTemplateName"], message: "Select an approved WhatsApp template." });
    }
  }),
});

const campaignPreviewSchema = z.object({
  body: z.object({
    audienceId: objectId,
    channel: z.enum(["whatsapp", "email"]).default("whatsapp"),
    skipAlreadySent: z.boolean().optional().default(true),
    category: z.enum(["MARKETING", "UTILITY", "Marketing", "Utility"]).optional().default("MARKETING"),
  }),
});

const campaignTestSendSchema = z.object({
  body: z.object({
    phone: z.string().trim().min(7).max(32),
    audienceId: objectId,
    whatsappTemplateName: z.string().trim().min(1).max(200),
    whatsappTemplateLanguage: z.string().trim().max(30).optional().default("en_US"),
    whatsappTemplateCategory: z.string().trim().max(40).optional().default("MARKETING"),
    whatsappTemplateBody: z.string().max(1024).optional().default(""),
    whatsappTemplateHeaderType: z.enum(["none", "text", "image", "document", "pdf", "brochure"]).optional().default("none"),
    whatsappTemplateHeaderImageUrl: z.string().url().max(2000).optional().or(z.literal("")).default(""),
    whatsappTemplateHeaderDocumentUrl: z.string().url().max(2000).optional().or(z.literal("")).default(""),
    whatsappTemplateVariables: z.array(z.object({
      index: z.number().int().min(1).max(10),
      source: z.enum(["name", "phone", "email", "city", "budget", "static"]),
      value: z.string().max(1000).optional().default(""),
      fallback: z.string().max(200).optional().default("Sir/Ma’am"),
    })).max(10).optional().default([]),
  }),
});

const campaignIdSchema = z.object({
  params: z.object({ id: objectId }),
});

const retrySchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({ channel: z.enum(["whatsapp", "email"]).optional() })
    .optional()
    .default({}),
});

const listJobsQuerySchema = z.object({
  query: z.object({
    channel: z.enum(["whatsapp", "email"]).optional(),
    campaignId: objectId.optional(),
    status: z
      .enum([
        "pending",
        "scheduled",
        "processing",
        "sent",
        "failed",
        "paused",
        "cancelled",
      ])
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
});

module.exports = {
  launchCampaignSchema,
  campaignPreviewSchema,
  campaignTestSendSchema,
  campaignIdSchema,
  retrySchema,
  listJobsQuerySchema,
};
