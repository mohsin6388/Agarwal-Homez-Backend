const mongoose = require('mongoose');
const { Schema } = mongoose;

const buttonSchema = new Schema({
  type: { type: String, enum: ['QUICK_REPLY'], default: 'QUICK_REPLY' },
  text: { type: String, trim: true, maxlength: 25, required: true },
}, { _id: false });

const schema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, trim: true, default: '', maxlength: 512 },
  category: { type: String, enum: ['MARKETING', 'UTILITY'], default: 'MARKETING' },
  language: { type: String, trim: true, default: 'hi' },
  headerType: { type: String, enum: ['none', 'text', 'image', 'document'], default: 'none' },
  headerText: { type: String, trim: true, default: '', maxlength: 60 },
  headerImageUrl: { type: String, trim: true, default: '' },
  headerDocumentUrl: { type: String, trim: true, default: '' },
  headerFileName: { type: String, trim: true, default: '' },
  bodyText: { type: String, trim: true, default: '', maxlength: 1024 },
  footerText: { type: String, trim: true, default: '', maxlength: 60 },
  buttons: { type: [buttonSchema], default: [] },
  sampleValues: { type: [String], default: [] },
}, { timestamps: true });

schema.index({ ownerId: 1, updatedAt: -1 }, { name: 'owner_whatsapp_template_drafts' });
module.exports = mongoose.model('WhatsAppTemplateDraft', schema);
