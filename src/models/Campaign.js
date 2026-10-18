const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Ek bulk upload = ek Campaign.
 * Leads ek saath upload hoti hain, par bhejna `dailyLimit` leads/din ke hisab se
 * `sendTime` par hota hai. Har lead ko (agar channel on hai) pehle WhatsApp,
 * phir Email jata hai.
 */
const campaignSchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },

    channels: {
      whatsapp: { type: Boolean, default: true },
      email: { type: Boolean, default: false },
    },

    // Ek din mein kitni LEADS ko message jayega (har lead = WhatsApp + Email).
    // Keep campaigns paced by default; the worker still sends one message at a time.
    dailyLimit: { type: Number, default: 5000, min: 1, max: 20000 },
    // HH:mm, Asia/Kolkata. Har din is time par us din ka batch shuru hota hai.
    sendTime: { type: String, default: "10:00" },
    // YYYY-MM-DD (Asia/Kolkata) — pehla batch is din
    startDate: { type: String, required: true },
    scheduleAt: { type: Date, default: null },
    audienceId: { type: Schema.Types.ObjectId, ref: "Audience", default: null, index: true },
    skipAlreadySent: { type: Boolean, default: false },
    optInConfirmed: { type: Boolean, default: false },
    optInConfirmedAt: { type: Date, default: null },

    whatsappTemplate: {
      name: { type: String, default: "" },
      language: { type: String, default: "en_US" },
      category: { type: String, default: "" },
      variables: [{ index: { type: Number }, source: { type: String, enum: ["name", "phone", "email", "city", "budget", "static"], default: "name" }, value: { type: String, default: "" }, fallback: { type: String, default: "Sir/Ma’am" } }],
      headerType: { type: String, enum: ["none", "text", "image", "document", "pdf", "brochure"], default: "none" },
      headerImageUrl: { type: String, default: "" },
      headerDocumentUrl: { type: String, default: "" },
      body: { type: String, default: "", maxlength: 1024 },
    },

    email: {
      templateId: { type: Schema.Types.ObjectId, ref: "EmailTemplate", default: null },
      templateName: { type: String, default: "", trim: true, maxlength: 100 },
      subject: { type: String, default: "", trim: true, maxlength: 200 },
      // Plain text snapshot; {{name}} placeholder supported. Existing campaigns remain unchanged if template edited later.
      body: { type: String, default: "", maxlength: 5000 },
      imageUrl: { type: String, default: "" },
      brochureUrl: { type: String, default: "" },
      ctaText: { type: String, default: "" },
      ctaUrl: { type: String, default: "" },
    },

    status: {
      type: String,
      enum: ["active", "paused", "completed", "cancelled"],
      default: "active",
      index: true,
    },

    totalLeads: { type: Number, default: 0 },
    // Leads jinke paas email nahi tha (email channel on hone par bhi skip hui)
    leadsWithoutEmail: { type: Number, default: 0 },
    totalDays: { type: Number, default: 1 },
    firstRunAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

campaignSchema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model("Campaign", campaignSchema);
