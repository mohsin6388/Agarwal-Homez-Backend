/**
 * One-time, safe migration for tenants' existing Leads collection.
 * Removes the old unique (ownerId, phone) index that treats null/missing phone
 * values as duplicates, normalizes blank contact fields, then creates the new
 * partial unique index that applies only to actual string phone numbers.
 * Run during a maintenance window after backing up MongoDB.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  await mongoose.connect(uri);
  const collection = mongoose.connection.collection('leads');
  const indexes = await collection.indexes();

  for (const index of indexes) {
    const keys = Object.keys(index.key || {});
    const isLegacyPhoneIndex = index.unique && keys.length === 2 && index.key.ownerId === 1 && index.key.phone === 1 && !index.partialFilterExpression;
    if (isLegacyPhoneIndex) {
      console.log(`[migration] dropping legacy index ${index.name}`);
      await collection.dropIndex(index.name);
    }
  }

  const cleanup = await collection.updateMany(
    { $or: [{ phone: '' }, { phone: { $exists: false } }, { phone: { $type: 'string', $regex: /^\s*$/ } }] },
    { $set: { phone: null } },
  );
  if (cleanup.modifiedCount) console.log(`[migration] normalized ${cleanup.modifiedCount} blank/missing phone field(s)`);

  // Backfill additive contact fields. Older imported rows may not have the
  // original filename anymore, so sourceFile stays blank unless known.
  const contactCursor = collection.find({
    $or: [
      { address: { $exists: false } },
      { sourceType: { $exists: false } },
      { sourceFile: { $exists: false } },
      { inCrm: { $exists: false } },
    ],
  }, { projection: { _id: 1, source: 1, address: 1, sourceType: 1, sourceFile: 1, inCrm: 1 } });
  let operations = [];
  let backfilled = 0;
  for await (const lead of contactCursor) {
    const set = {};
    if (lead.address === undefined) set.address = '';
    if (lead.sourceFile === undefined) set.sourceFile = '';
    if (lead.inCrm === undefined) set.inCrm = true;
    if (lead.sourceType === undefined) {
      const source = String(lead.source || '').toLowerCase();
      if (source.includes('manual')) set.sourceType = 'manual';
      else if (source.includes('paste')) set.sourceType = 'paste';
      else if (source.includes('excel') || source.includes('xlsx')) set.sourceType = 'excel';
      else if (source.includes('csv')) set.sourceType = 'csv';
      else set.sourceType = 'other';
    }
    if (Object.keys(set).length) operations.push({ updateOne: { filter: { _id: lead._id }, update: { $set: set } } });
    if (operations.length >= 500) {
      const result = await collection.bulkWrite(operations, { ordered: false });
      backfilled += result.modifiedCount;
      operations = [];
    }
  }
  if (operations.length) {
    const result = await collection.bulkWrite(operations, { ordered: false });
    backfilled += result.modifiedCount;
  }
  if (backfilled) console.log(`[migration] backfilled new contact fields on ${backfilled} lead(s)`);

  await collection.createIndex(
    { ownerId: 1, phone: 1 },
    { unique: true, partialFilterExpression: { phone: { $type: 'string' } }, name: 'owner_phone_unique_nonempty' },
  );
  await collection.createIndex({ ownerId: 1, inCrm: 1, sourceType: 1, sourceFile: 1 }, { name: 'owner_contact_source_filter' });
  await collection.createIndex({ ownerId: 1, inCrm: 1, city: 1 }, { name: 'owner_contact_city_filter' });
  await collection.createIndex({ ownerId: 1, inCrm: 1, occupation: 1 }, { name: 'owner_contact_occupation_filter' });
  await collection.createIndex({ ownerId: 1, leadScore: -1, updatedAt: -1 }, { name: 'owner_lead_score_updated' });
  const jobCollection = mongoose.connection.collection('outboundjobs');
  await jobCollection.createIndex({ ownerId: 1, channel: 1, status: 1, leadId: 1 }, { name: 'owner_channel_delivery_lead' });
  console.log('[migration] owner_phone_unique_nonempty and contact-query indexes are ready');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[migration] failed:', error.message);
  try { await mongoose.disconnect(); } catch { /* best effort */ }
  process.exitCode = 1;
});
