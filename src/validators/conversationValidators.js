const { z } = require("zod");

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

const listConversationsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(20),
    filter: z
      .enum(["unread", "hot", "warm", "cold", "site_visit", "closed", "lost"])
      .optional(),
    search: z.string().optional(),
    leadId: objectId.optional(),
    ownerId: objectId.optional(),
  }),
});

const getConversationSchema = z.object({
  params: z.object({ id: objectId }),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    before: z.string().max(40).optional(),
    ownerId: objectId.optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: objectId }),
  query: z.object({ ownerId: objectId.optional() }).optional(),
});

const sendManualReplySchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    text: z.string().min(1, "Message text is required").max(4096),
  }),
});

const sendTemplateSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    templateName: z.string().trim().min(1).max(512),
    language: z.string().trim().max(20).optional(),
    category: z.string().trim().max(40).optional(),
    headerImageUrl: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .refine(
        (v) => !v || /^https?:\/\//i.test(v),
        "Image URL http(s) honi chahiye",
      ),
    variables: z
      .array(
        z.object({
          index: z.coerce.number().int().min(1).max(50),
          source: z.enum(["name", "phone", "email", "static"]).default("name"),
          value: z.string().max(1024).optional().default(""),
        }),
      )
      .max(50)
      .optional()
      .default([]),
    body: z.string().max(4096).optional(),
    header: z.string().max(200).optional(),
    footer: z.string().max(200).optional(),
    buttons: z.array(z.string().max(100)).max(10).optional(),
  }),
});

module.exports = {
  sendTemplateSchema,
  listConversationsSchema,
  getConversationSchema,
  idParamSchema,
  sendManualReplySchema,
};
