const mongoose = require('mongoose');
const { Schema } = mongoose;

const LEAD_STATUSES = [
  'new', 'contacted', 'qualified', 'hot', 'warm', 'cold',
  'site_visit', 'closed', 'lost',
];

const leadSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // broker
    // organizationId: { type: Schema.Types.ObjectId, required: true, index: true },

    name: { type: String, required: true, trim: true },
    phone: { type: String, default: null, trim: true },
    email: { type: String, trim: true, lowercase: true },
    emailOptOut: { type: Boolean, default: false, index: true },
    emailOptOutAt: { type: Date, default: null },
    city: { type: String, trim: true },
    location: { type: String, trim: true },
    address: { type: String, trim: true, default: '' },
    budgetMin: { type: Number, default: null },
    budgetMax: { type: Number, default: null },
    occupation: { type: String, trim: true },
    age: { type: Number, default: null },
    source: { type: String, trim: true, default: 'manual' },
    sourceType: { type: String, enum: ['excel', 'csv', 'manual', 'paste', 'other'], default: 'other' },
    sourceFile: { type: String, trim: true, default: '' },
    inCrm: { type: Boolean, default: true },
    notes: { type: String, trim: true },
    requirements: { type: String, trim: true },

    tags: [{ type: String, trim: true }],
    status: { type: String, enum: LEAD_STATUSES, default: 'new', index: true },
    leadScore: { type: Number, default: 0, min: 0, max: 100 },
    hotAlertSentAt: { type: Date, default: null },
    warmAlertSentAt: { type: Date, default: null },

    duplicateOf: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// A phone number must be unique per broker (not globally) - two different
// brokers can legitimately have the same buyer in their own pipeline.
// Email-only leads must not collide on null/missing phone values. Deployments
// should migrate the old ownerId_1_phone_1 unique index as documented in README.
leadSchema.index(
  { ownerId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string" } }, name: "owner_phone_unique_nonempty" },
);
leadSchema.index({ ownerId: 1, email: 1 });
leadSchema.index({ ownerId: 1, status: 1 });
leadSchema.index({ ownerId: 1, inCrm: 1, sourceType: 1, sourceFile: 1 }, { name: 'owner_contact_source_filter' });
leadSchema.index({ ownerId: 1, inCrm: 1, city: 1 }, { name: 'owner_contact_city_filter' });
leadSchema.index({ ownerId: 1, inCrm: 1, occupation: 1 }, { name: 'owner_contact_occupation_filter' });
leadSchema.index({ ownerId: 1, leadScore: -1, updatedAt: -1 }, { name: 'owner_lead_score_updated' });
leadSchema.index({ name: 'text', notes: 'text', requirements: 'text' });

leadSchema.statics.STATUSES = LEAD_STATUSES;

module.exports = mongoose.model('Lead', leadSchema);
