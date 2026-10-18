const { z } = require('zod');

const rowSchema = z.record(z.any());
const createAudienceSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120),
    tags: z.array(z.string().trim().max(40)).max(20).optional(),
    sourceType: z.enum(['upload', 'paste', 'leads']),
    sourceLabel: z.string().max(255).optional(),
    sourceFileName: z.string().max(255).optional(),
    rows: z.array(rowSchema).min(1).max(20000),
    addToCrm: z.boolean().optional(),
    addCountryCode: z.boolean().optional(),
  }),
});

const audienceIdSchema = z.object({ params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid audience id') }) });
module.exports = { createAudienceSchema, audienceIdSchema };
