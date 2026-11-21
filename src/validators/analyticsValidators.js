const { z } = require("zod");

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

const dashboardQuerySchema = z.object({
  query: z.object({
    ownerId: objectId.optional(),
  }),
});

const rangeQuerySchema = z.object({
  query: z.object({
    ownerId: objectId.optional(),
    from: z.string().optional(), // YYYY-MM-DD
    to: z.string().optional(), // YYYY-MM-DD
    granularity: z.enum(["daily", "weekly", "monthly"]).optional(),
    // Dashboard "Message activity" tabs. Pehle ye schema me nahi tha, isliye
    // validate() ise hata deta tha aur hamesha 7 din ka data aata tha.
    range: z.enum(["7d", "30d", "previous_month"]).optional(),
  }),
});

module.exports = { dashboardQuerySchema, rangeQuerySchema };
