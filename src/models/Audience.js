const mongoose = require('mongoose');
const { Schema } = mongoose;

const audienceSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  tags: { type: [String], default: [] },
  sourceType: { type: String, enum: ['upload', 'paste', 'leads'], required: true },
  sourceLabel: { type: String, trim: true, default: '' },
  sourceFileName: { type: String, trim: true, default: '' },
  leadIds: {
    type: [{ type: Schema.Types.ObjectId, ref: 'Lead' }],
    default: [],
    validate: {
      validator: (ids) => Array.isArray(ids) && ids.length <= 20000,
      message: 'An audience can contain at most 20,000 contacts',
    },
  },
  counts: {
    total: { type: Number, default: 0, min: 0 },
    valid: { type: Number, default: 0, min: 0 },
    duplicates: { type: Number, default: 0, min: 0 },
    invalid: { type: Number, default: 0, min: 0 },
  },
  invalidRowCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

audienceSchema.index({ ownerId: 1, createdAt: -1 }, { name: 'owner_audience_created' });
audienceSchema.index({ ownerId: 1, name: 1 }, { name: 'owner_audience_name' });
audienceSchema.index({ ownerId: 1, sourceType: 1, createdAt: -1 }, { name: 'owner_audience_source' });

module.exports = mongoose.model('Audience', audienceSchema);
