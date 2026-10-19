const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_AUDIENCE_CONTACTS = 20000;

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value, addCountryCode = true) {
  const digits = digitsOnly(value);
  if (!digits || digits.length < 7 || digits.length > 15) return null;
  if (addCountryCode && digits.length === 10) return `91${digits}`;
  return digits;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function fallbackName(row, phone, email) {
  const name = String(row.name || '').trim();
  if (name) return name.slice(0, 150);
  if (email) return email.split('@')[0].replace(/[._+-]+/g, ' ').trim() || 'Email lead';
  if (phone) return `Lead ${phone.slice(-4)}`;
  return 'New lead';
}

function phoneLookupVariants(values) {
  const variants = new Set();
  for (const value of values) {
    const digits = digitsOnly(value);
    if (!digits) continue;
    variants.add(digits);
    variants.add(`+${digits}`);
    const last10 = digits.slice(-10);
    if (last10.length === 10) {
      variants.add(last10);
      variants.add(`+${last10}`);
      variants.add(`91${last10}`);
      variants.add(`+91${last10}`);
    }
  }
  return [...variants];
}

function normalizedExistingPhone(value) {
  const digits = digitsOnly(value);
  return digits || null;
}

function addPhoneToMap(map, rawPhone, lead) {
  const digits = normalizedExistingPhone(rawPhone);
  if (!digits) return;
  if (!map.has(digits)) map.set(digits, lead);
  const last10 = digits.slice(-10);
  if (last10.length === 10 && !map.has(last10)) map.set(last10, lead);
}

/**
 * Resolve every valid audience row to a real, owner-scoped Lead document.
 * Existing contacts are reused (and optionally filled with missing data),
 * while only genuinely new rows create new Leads. No outbound message is sent.
 */
async function resolveLeadsForRows(ownerId, inputRows, options = {}) {
  const rows = Array.isArray(inputRows) ? inputRows : [];
  const addToCrm = options.addToCrm !== false;
  const addCountryCode = options.addCountryCode !== false;
  const sourceType = options.sourceType || 'paste';
  const sourceFileName = String(options.sourceFileName || '').slice(0, 255);

  if (rows.length > MAX_AUDIENCE_CONTACTS) {
    const error = new Error(`An audience can contain at most ${MAX_AUDIENCE_CONTACTS.toLocaleString('en-IN')} contacts`);
    error.statusCode = 400;
    throw error;
  }

  const normalized = [];
  const seenPhones = new Set();
  const seenEmails = new Set();
  let duplicateCount = 0;
  let invalidCount = 0;

  for (const raw of rows) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const leadId = row.leadId || row._id || null;
    const phone = normalizePhone(row.phone, addCountryCode);
    const email = normalizeEmail(row.email);

    // Existing selected leads can be resolved directly even when the row has
    // neither a phone nor email (though normal CRM contacts should have one).
    if (!phone && !email && !leadId) {
      invalidCount += 1;
      continue;
    }
    if (phone && seenPhones.has(phone)) { duplicateCount += 1; continue; }
    if (email && seenEmails.has(email)) { duplicateCount += 1; continue; }
    if (phone) seenPhones.add(phone);
    if (email) seenEmails.add(email);
    normalized.push({ row, leadId, phone, email });
  }

  if (!normalized.length) {
    const error = new Error('Audience mein save karne ke liye koi valid contact nahi mila.');
    error.statusCode = 400;
    throw error;
  }

  const selectedIds = [...new Set(normalized.map((item) => String(item.leadId || '')).filter((id) => /^[a-f\d]{24}$/i.test(id)))];
  const phoneValues = normalized.map((item) => item.phone).filter(Boolean);
  const emailValues = normalized.map((item) => item.email).filter(Boolean);
  const or = [];
  if (selectedIds.length) or.push({ _id: { $in: selectedIds } });
  if (phoneValues.length) or.push({ phone: { $in: phoneLookupVariants(phoneValues) } });
  if (emailValues.length) or.push({ email: { $in: emailValues } });
  const existing = or.length ? await Lead.find({ ownerId, $or: or }).lean() : [];

  const byId = new Map(existing.map((lead) => [String(lead._id), lead]));
  const byPhone = new Map();
  const byEmail = new Map();
  existing.forEach((lead) => {
    addPhoneToMap(byPhone, lead.phone, lead);
    const email = String(lead.email || '').trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, lead);
  });

  const updatesById = new Map();
  const newRows = [];
  const rowKeys = new Map();

  for (const item of normalized) {
    const { row, leadId, phone, email } = item;
    let matched = leadId ? byId.get(String(leadId)) : null;
    // A supplied leadId must resolve within this owner. Never fall through to
    // a same-phone contact owned by another broker.
    if (leadId && !matched) {
      invalidCount += 1;
      continue;
    }
    if (!matched && phone) matched = byPhone.get(phone) || byPhone.get(phone.slice(-10));
    if (!matched && email) matched = byEmail.get(email);

    if (matched) {
      const set = {};
      const rowName = String(row.name || '').trim();
      if (rowName && (!String(matched.name || '').trim() || /^(lead\s+\d+|whatsapp\s+\d+|new lead|email lead)$/i.test(matched.name.trim()))) set.name = rowName.slice(0, 150);
      if (phone && !matched.phone) set.phone = phone;
      if (email && !matched.email) set.email = email;
      for (const [key, value] of [
        ['address', row.address], ['city', row.city], ['location', row.location],
        ['occupation', row.occupation || row.jobTitle || row.designation],
        ['notes', row.notes], ['requirements', row.requirements],
      ]) {
        if (value !== undefined && value !== null && String(value).trim() && !String(matched[key] || '').trim()) set[key] = String(value).trim().slice(0, key === 'address' ? 1000 : 500);
      }
      if (row.budgetMin !== undefined && matched.budgetMin == null && row.budgetMin !== null) set.budgetMin = row.budgetMin;
      if (row.budgetMax !== undefined && matched.budgetMax == null && row.budgetMax !== null) set.budgetMax = row.budgetMax;
      if (addToCrm && matched.inCrm === false) set.inCrm = true;
      if (Object.keys(set).length) {
        updatesById.set(String(matched._id), { _id: matched._id, set });
        Object.assign(matched, set);
      }
      rowKeys.set(item, matched._id);
      continue;
    }

    const rowKey = phone ? `phone:${phone}` : `email:${email}`;
    newRows.push({ ...item, rowKey });
  }

  if (updatesById.size) {
    await Lead.bulkWrite([...updatesById.values()].map(({ _id, set }) => ({
      updateOne: { filter: { _id, ownerId }, update: { $set: set } },
    })), { ordered: false });
  }

  const leadSourceType = sourceType === 'upload'
    ? (/\.xlsx$/i.test(sourceFileName) ? 'excel' : 'csv')
    : sourceType === 'paste' ? 'paste' : 'other';
  const docs = newRows.map(({ row, phone, email }) => ({
    ownerId,
    name: fallbackName(row, phone, email),
    phone: phone || null,
    email: email || undefined,
    address: String(row.address || '').trim().slice(0, 1000),
    city: String(row.city || '').trim().slice(0, 120) || undefined,
    location: String(row.location || '').trim().slice(0, 120) || undefined,
    occupation: String(row.occupation || row.jobTitle || row.designation || '').trim().slice(0, 150) || undefined,
    budgetMin: row.budgetMin ?? null,
    budgetMax: row.budgetMax ?? null,
    source: sourceType === 'leads' ? 'audience_existing_lead' : `audience_${sourceType}`,
    sourceType: leadSourceType,
    sourceFile: sourceType === 'upload' ? sourceFileName : '',
    inCrm: addToCrm,
  }));

  if (docs.length) {
    try {
      await Lead.insertMany(docs, { ordered: false });
    } catch (error) {
      // A concurrent import may win the unique phone index. Resolve by phone
      // and email below so the saved audience still points at the real Lead.
      if (!error.writeErrors) throw error;
    }
  }

  const lookupOr = [];
  if (phoneValues.length || newRows.length) lookupOr.push({ phone: { $in: phoneLookupVariants([...phoneValues, ...newRows.map((item) => item.phone).filter(Boolean)]) } });
  if (emailValues.length || newRows.length) lookupOr.push({ email: { $in: [...new Set([...emailValues, ...newRows.map((item) => item.email).filter(Boolean)])] } });
  if (selectedIds.length) lookupOr.push({ _id: { $in: selectedIds } });
  const allResolved = lookupOr.length ? await Lead.find({ ownerId, $or: lookupOr }).lean() : [];
  const resolvedById = new Map(allResolved.map((lead) => [String(lead._id), lead]));
  const resolvedByPhone = new Map();
  const resolvedByEmail = new Map();
  allResolved.forEach((lead) => {
    addPhoneToMap(resolvedByPhone, lead.phone, lead);
    const email = String(lead.email || '').trim().toLowerCase();
    if (email && !resolvedByEmail.has(email)) resolvedByEmail.set(email, lead);
  });

  const leadIds = [];
  for (const item of normalized) {
    const directId = rowKeys.get(item);
    let lead = directId ? resolvedById.get(String(directId)) : null;
    if (!lead && item.leadId) lead = resolvedById.get(String(item.leadId));
    if (!lead && item.phone) lead = resolvedByPhone.get(item.phone) || resolvedByPhone.get(item.phone.slice(-10));
    if (!lead && item.email) lead = resolvedByEmail.get(item.email);
    if (lead && !leadIds.some((id) => String(id) === String(lead._id))) leadIds.push(lead._id);
  }

  if (!leadIds.length) {
    const error = new Error('Contacts ko Lead records se resolve nahi kar paaye. Preview dobara karke save karein.');
    error.statusCode = 400;
    throw error;
  }

  const phoneLeadIds = allResolved.filter((lead) => leadIds.some((id) => String(id) === String(lead._id)) && lead.phone).map((lead) => lead._id);
  if (phoneLeadIds.length) {
    try {
      await Conversation.bulkWrite(phoneLeadIds.map((leadId) => ({
        updateOne: {
          filter: { ownerId, leadId },
          update: { $setOnInsert: { ownerId, leadId } },
          upsert: true,
        },
      })), { ordered: false });
    } catch (error) {
      if (!error.writeErrors || error.writeErrors.some((entry) => entry.code !== 11000)) throw error;
    }
  }

  return {
    leadIds: leadIds.slice(0, MAX_AUDIENCE_CONTACTS),
    resolved: leadIds.length,
    inserted: Math.max(0, leadIds.length - rowKeys.size),
    duplicates: duplicateCount,
    invalid: invalidCount,
  };
}

module.exports = { resolveLeadsForRows, normalizePhone, normalizeEmail, MAX_AUDIENCE_CONTACTS };
