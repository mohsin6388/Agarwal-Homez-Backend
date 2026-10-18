require("dotenv").config();
const mongoose = require("mongoose");
const env = require("../config/env");
const WhatsAppTemplateDraft = require("../models/WhatsAppTemplateDraft");

(async () => {
  try {
    await mongoose.connect(env.mongoUri);
    await WhatsAppTemplateDraft.createIndexes();
    console.log("WhatsApp template draft indexes created/verified.");
  } catch (error) {
    console.error("WhatsApp template draft index migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
})();
