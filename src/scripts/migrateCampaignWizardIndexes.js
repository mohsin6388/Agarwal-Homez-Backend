const mongoose = require("mongoose");
const env = require("../config/env");
const Campaign = require("../models/Campaign");
const OutboundJob = require("../models/OutboundJob");

async function main() {
  const uri = env.mongoUri || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI is not configured");
  await mongoose.connect(uri);
  await Campaign.collection.createIndex({ ownerId: 1, audienceId: 1 }, { name: "owner_campaign_audience" });
  await OutboundJob.collection.createIndex({ ownerId: 1, channel: 1, status: 1, leadId: 1 }, { name: "owner_channel_delivery_lead" });
  console.log("Campaign wizard indexes ensured.");
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Campaign wizard index migration failed:", error.message);
  try { await mongoose.disconnect(); } catch {}
  process.exitCode = 1;
});
