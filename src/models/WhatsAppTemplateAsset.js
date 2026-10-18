const mongoose = require('mongoose');
const { Schema } = mongoose;
const buttonSchema = new Schema({
  type: { type: String, enum: ['QUICK_REPLY'], default: 'QUICK_REPLY' },
  text: { type: String, trim: true, maxlength: 25 },
}, { _id: false });

const schema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  language: { type: String, required: true, trim: true, default: 'en_US' },
  imageUrl: { type: String, default: '', trim: true },
  headerType: { type: String, enum: ['none', 'text', 'image', 'document'], default: 'none' },
  headerText: { type: String, default: '', trim: true },
  documentUrl: { type: String, default: '', trim: true },
  headerFileName: { type: String, default: '', trim: true },
  footerText: { type: String, default: '', trim: true },
  buttons: { type: [buttonSchema], default: [] },
  bodyText: { type: String, default: '', trim: true },
}, { timestamps: true });
schema.index({ ownerId: 1, name: 1, language: 1 }, { unique: true });
module.exports = mongoose.model('WhatsAppTemplateAsset', schema);
