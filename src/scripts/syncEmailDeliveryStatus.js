/**
 * One-time backfill: purani campaign emails ka asli delivery status (EmailMessage, jo Brevo
 * webhook se aaya) ko OutboundJob me copy karta hai, taaki Bulk Email page par
 * purani emails "Delivery pending" me na atki rahein.
 *   delivered / complained         -> deliveryStatus = delivered
 *   bounced / failed / suppressed  -> deliveryStatus = failed (+ errorMessage)
 * Jinka Brevo se koi final status nahi aaya wo pending hi rahenge.
 * Run: npm run sync:email-delivery   (safe, dobara chalane se kuch nahi bigadta)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const EmailMessage = require('../models/EmailMessage');
const OutboundJob = require('../models/OutboundJob');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  await mongoose.connect(uri);

  const rows = await EmailMessage.find({
    direction: 'outbound',
    outboundJobId: { $ne: null },
    status: { $in: ['delivered', 'complained', 'bounced', 'failed', 'suppressed'] },
  }).select('outboundJobId status errorMessage updatedAt').lean();

  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    if (['delivered', 'complained'].includes(row.status)) {
      const res = await OutboundJob.updateOne(
        { _id: row.outboundJobId, deliveryStatus: { $nin: ['failed', 'read', 'delivered'] } },
        { $set: { deliveryStatus: 'delivered', deliveryUpdatedAt: row.updatedAt || new Date() } },
      );
      delivered += res.modifiedCount;
    } else {
      const res = await OutboundJob.updateOne(
        { _id: row.outboundJobId, deliveryStatus: { $ne: 'failed' } },
        { $set: {
          deliveryStatus: 'failed',
          deliveryErrorCode: row.status,
          deliveryError: String(row.errorMessage || 'Email address par deliver nahi hui (bounce / block).').slice(0, 500),
          deliveryUpdatedAt: row.updatedAt || new Date(),
        } },
      );
      failed += res.modifiedCount;
    }
  }
  console.log(`[email-sync] ${rows.length} emails checked · ${delivered} delivered · ${failed} failed`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
