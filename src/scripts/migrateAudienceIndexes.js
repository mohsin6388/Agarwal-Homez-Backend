require("dotenv").config();
const mongoose = require("mongoose");
const env = require("../config/env");
const Audience = require("../models/Audience");
const AudienceInvalidRow = require("../models/AudienceInvalidRow");

(async () => {
  try {
    await mongoose.connect(env.mongoUri);
    await Audience.createIndexes();
    await AudienceInvalidRow.createIndexes();
    console.log("Audience and invalid-row indexes created/verified.");
  } catch (error) {
    console.error("Audience index migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
})();
