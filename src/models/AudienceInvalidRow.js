const mongoose = require('mongoose');
const { Schema } = mongoose;

const audienceInvalidRowSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  audienceId: { type: Schema.Types.ObjectId, ref: 'Audience', required: true },
  rowNumber: { type: Number, default: null },
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  reason: { type: String, default: '' },
}, { timestamps: true });

audienceInvalidRowSchema.index({ ownerId: 1, audienceId: 1, rowNumber: 1 }, { name: 'owner_audience_invalid_rows' });
module.exports = mongoose.model('AudienceInvalidRow', audienceInvalidRowSchema);
