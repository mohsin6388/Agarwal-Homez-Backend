// const mongoose = require('mongoose');
// const { Schema } = mongoose;

// const LEAD_STATUSES = [
//   'new', 'contacted', 'qualified', 'hot', 'warm', 'cold',
//   'site_visit', 'closed', 'lost',
// ];

// const leadSchema = new Schema(
//   {
//     ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // broker
//     // organizationId: { type: Schema.Types.ObjectId, required: true, index: true },

//     name: { type: String, required: true, trim: true },
//     phone: { type: String, default: null, trim: true },
//     email: { type: String, trim: true, lowercase: true },
//     city: { type: String, trim: true },
//     location: { type: String, trim: true },
//     // Upload Data fields (name, mobile, email, address, job title).
//     address: { type: String, trim: true },
//     jobTitle: { type: String, trim: true },
//     // Sheet the contact came from (e.g. "kanpur_leads_oct.xlsx"); lets bulk
//     // messaging show "contacts from this sheet" in one click.
//     importFile: { type: String, trim: true, default: null },
//     budgetMin: { type: Number, default: null },
//     budgetMax: { type: Number, default: null },
//     occupation: { type: String, trim: true },
//     age: { type: Number, default: null },
//     source: { type: String, trim: true, default: 'manual' },
//     notes: { type: String, trim: true },
//     requirements: { type: String, trim: true },

//     tags: [{ type: String, trim: true }],
//     status: { type: String, enum: LEAD_STATUSES, default: 'new', index: true },
//     leadScore: { type: Number, default: 0, min: 0, max: 100 },
//     hotAlertSentAt: { type: Date, default: null },
//     warmAlertSentAt: { type: Date, default: null },

//     duplicateOf: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
//     assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
//   },
//   { timestamps: true }
// );

// // A phone number must be unique per broker (not globally) - two different
// // brokers can legitimately have the same buyer in their own pipeline.
// // Email-only leads must not collide on null/missing phone values. Deployments
// // should migrate the old ownerId_1_phone_1 unique index as documented in README.
// leadSchema.index(
//   { ownerId: 1, phone: 1 },
//   { unique: true, partialFilterExpression: { phone: { $type: "string" } }, name: "owner_phone_unique_nonempty" },
// );
// leadSchema.index({ ownerId: 1, email: 1 });
// leadSchema.index({ ownerId: 1, status: 1 });
// leadSchema.index({ ownerId: 1, importFile: 1, createdAt: 1 });
// leadSchema.index({ name: 'text', notes: 'text', requirements: 'text' });

// leadSchema.statics.STATUSES = LEAD_STATUSES;

// module.exports = mongoose.model('Lead', leadSchema);

const mongoose = require("mongoose");
const { Schema } = mongoose;

const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "hot",
  "warm",
  "cold",
  "site_visit",
  "closed",
  "lost",
];

const leadSchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    }, // broker
    // organizationId: { type: Schema.Types.ObjectId, required: true, index: true },

    name: { type: String, required: true, trim: true },
    phone: { type: String, default: null, trim: true },
    email: { type: String, trim: true, lowercase: true },
    city: { type: String, trim: true },
    location: { type: String, trim: true },
    budgetMin: { type: Number, default: null },
    budgetMax: { type: Number, default: null },
    occupation: { type: String, trim: true },
    age: { type: Number, default: null },
    source: { type: String, trim: true, default: "manual" },
    notes: { type: String, trim: true },
    requirements: { type: String, trim: true },

    tags: [{ type: String, trim: true }],
    status: { type: String, enum: LEAD_STATUSES, default: "new", index: true },
    leadScore: { type: Number, default: 0, min: 0, max: 100 },

    // WhatsApp deliverability state — Meta ke delivery webhooks se update hota
    // hai (services/whatsapp/deliveryHealth.js). Bulk campaigns isse padh ke
    // bekaar / risky numbers skip karte hain, taaki number ki quality na gire.
    whatsappHealth: {
      // ok | invalid (131026: WhatsApp par nahi / undeliverable)
      status: { type: String, enum: ["ok", "invalid"], default: "ok" },
      invalidAt: { type: Date, default: null },
      invalidCount: { type: Number, default: 0 },
      // 131049 (per-user marketing limit): is date tak MARKETING template mat bhejo
      marketingBlockedUntil: { type: Date, default: null },
      marketingBlockCount: { type: Number, default: 0 },
      // 131050 / user_preferences "stop" / STOP reply: marketing permanently band
      marketingOptOut: { type: Boolean, default: false },
      marketingOptOutAt: { type: Date, default: null },
      lastErrorCode: { type: String, default: null },
      lastErrorAt: { type: Date, default: null },
      lastDeliveredAt: { type: Date, default: null },
    },

    duplicateOf: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// A phone number must be unique per broker (not globally) - two different
// brokers can legitimately have the same buyer in their own pipeline.
// Email-only leads must not collide on null/missing phone values. Deployments
// should migrate the old ownerId_1_phone_1 unique index as documented in README.
leadSchema.index(
  { ownerId: 1, phone: 1 },
  {
    unique: true,
    partialFilterExpression: { phone: { $type: "string" } },
    name: "owner_phone_unique_nonempty",
  },
);
leadSchema.index({ ownerId: 1, email: 1 });
leadSchema.index({ ownerId: 1, status: 1 });
leadSchema.index({ name: "text", notes: "text", requirements: "text" });

leadSchema.statics.STATUSES = LEAD_STATUSES;

module.exports = mongoose.model("Lead", leadSchema);
