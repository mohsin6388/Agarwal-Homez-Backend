// const { Parser: CsvParser } = require("json2csv");
// const mongoose = require("mongoose");
// const asyncHandler = require("../utils/asyncHandler");
// const ApiError = require("../utils/ApiError");
// const ApiResponse = require("../utils/ApiResponse");
// const Audience = require("../models/Audience");
// const AudienceInvalidRow = require("../models/AudienceInvalidRow");
// const Lead = require("../models/Lead");
// const Conversation = require("../models/Conversation");
// const Message = require("../models/Message");
// const EmailMessage = require("../models/EmailMessage");
// const Meeting = require("../models/Meeting");
// const OutboundJob = require("../models/OutboundJob");
// const AuditLog = require("../models/AuditLog");
// const {
//   parseCsvBuffer,
//   parseExcelBuffer,
//   parseLeadText,
//   analyzeRows,
// } = require("../services/csv/leadImporter");
// const {
//   resolveLeadsForRows,
//   MAX_AUDIENCE_CONTACTS,
// } = require("../services/audiences/resolveLeadsForRows");

// const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

// function parseBoolean(value, fallback = true) {
//   if (value === undefined || value === null || value === "") return fallback;
//   return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
// }

// function parseJsonField(value, fallback = {}) {
//   if (value && typeof value === "object") return value;
//   if (!value) return fallback;
//   try {
//     return JSON.parse(value);
//   } catch {
//     throw ApiError.badRequest("Filter settings valid JSON nahi hain.");
//   }
// }

// function normalizeRows(rows, addCountryCode) {
//   return (rows || []).map((row) => {
//     const rawDigits = String(row.phone || "").replace(/\D/g, "");
//     // Keep invalid digits visible in the preview/CSV so the user can correct
//     // them. The resolver drops an invalid optional phone if the row has email.
//     const phone =
//       rawDigits && addCountryCode && rawDigits.length === 10
//         ? `91${rawDigits}`
//         : rawDigits;
//     return {
//       ...row,
//       phone,
//       email: String(row.email || "")
//         .trim()
//         .toLowerCase(),
//       name: String(row.name || row.naam || "").trim(),
//       address: String(row.address || "").trim(),
//       occupation: String(
//         row.occupation || row.jobTitle || row.designation || "",
//       ).trim(),
//     };
//   });
// }

// async function getLeadFilterOptions(ownerId) {
//   const base = { ownerId, inCrm: { $ne: false } };
//   const [cities, jobTitles, sourceFiles] = await Promise.all([
//     Lead.distinct("city", { ...base, city: { $type: "string", $ne: "" } }),
//     Lead.distinct("occupation", {
//       ...base,
//       occupation: { $type: "string", $ne: "" },
//     }),
//     // The Upload Data importer stores the original workbook/CSV filename on
//     // each Lead. Returning distinct filenames lets users reuse contacts from
//     // a previously uploaded sheet without uploading it again.
//     Lead.distinct("sourceFile", {
//       ...base,
//       sourceType: { $in: ["excel", "csv"] },
//       sourceFile: { $type: "string", $ne: "" },
//     }),
//   ]);
//   return {
//     cities: cities
//       .map((value) => String(value).trim())
//       .filter(Boolean)
//       .sort((a, b) => a.localeCompare(b))
//       .slice(0, 500),
//     jobTitles: jobTitles
//       .map((value) => String(value).trim())
//       .filter(Boolean)
//       .sort((a, b) => a.localeCompare(b))
//       .slice(0, 500),
//     sourceFiles: sourceFiles
//       .map((value) => String(value).trim())
//       .filter(Boolean)
//       .sort((a, b) => a.localeCompare(b))
//       .slice(0, 1000),
//   };
// }

// async function getRepliedLeadIds(ownerId) {
//   const [conversationIds, emailLeadIds] = await Promise.all([
//     Conversation.find({ ownerId }).distinct("_id"),
//     EmailMessage.find({
//       ownerId,
//       direction: "inbound",
//       kind: "received",
//       leadId: { $ne: null },
//     }).distinct("leadId"),
//   ]);
//   const whatsappLeadIds = conversationIds.length
//     ? await Message.find({
//         conversationId: { $in: conversationIds },
//         direction: "inbound",
//         sender: "customer",
//         leadId: { $ne: null },
//       }).distinct("leadId")
//     : [];
//   return [...new Set([...whatsappLeadIds, ...emailLeadIds].map(String))];
// }

// async function buildLeadRows(ownerId, rawFilter = {}) {
//   const filterOptions = await getLeadFilterOptions(ownerId);
//   const query = { ownerId, inCrm: { $ne: false } };
//   const selectedIds = Array.isArray(rawFilter.leadIds)
//     ? [
//         ...new Set(
//           rawFilter.leadIds.map(String).filter((id) => OBJECT_ID_RE.test(id)),
//         ),
//       ].slice(0, MAX_AUDIENCE_CONTACTS)
//     : [];

//   if (selectedIds.length)
//     query._id = {
//       $in: selectedIds.map((id) => new mongoose.Types.ObjectId(id)),
//     };
//   if (rawFilter.status === "hot") query.leadScore = { $gt: 60 };
//   if (rawFilter.sourceFile) {
//     // Exact-match the filename retained by the original Excel/CSV import.
//     // String equality avoids treating characters such as '.' or '+' as regex.
//     query.sourceFile = String(rawFilter.sourceFile).trim().slice(0, 255);
//   }
//   if (rawFilter.city)
//     query.city = new RegExp(
//       `^${String(rawFilter.city)
//         .slice(0, 120)
//         .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
//       "i",
//     );
//   if (rawFilter.jobTitle)
//     query.occupation = new RegExp(
//       `^${String(rawFilter.jobTitle)
//         .slice(0, 150)
//         .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
//       "i",
//     );

//   const dateRange = String(rawFilter.dateRange || "any");
//   if (dateRange === "7d" || dateRange === "30d") {
//     query.createdAt = {
//       $gte: new Date(
//         Date.now() - (dateRange === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000,
//       ),
//     };
//   }

//   const idAndClauses = [];
//   if (selectedIds.length) {
//     delete query._id;
//     idAndClauses.push({
//       _id: { $in: selectedIds.map((id) => new mongoose.Types.ObjectId(id)) },
//     });
//   }
//   if (rawFilter.status === "visit") {
//     const visitLeadIds = await Meeting.find({
//       ownerId,
//       status: { $ne: "cancelled" },
//     }).distinct("leadId");
//     idAndClauses.push({ _id: { $in: visitLeadIds } });
//     delete query._id;
//   }
//   if (rawFilter.status === "no_reply") {
//     const repliedIds = await getRepliedLeadIds(ownerId);
//     idAndClauses.push({
//       _id: { $nin: repliedIds.map((id) => new mongoose.Types.ObjectId(id)) },
//     });
//     delete query._id;
//   }
//   if (idAndClauses.length)
//     query.$and = [...(query.$and || []), ...idAndClauses];

//   const [leadDocs, totalAvailable] = await Promise.all([
//     Lead.find(query)
//       .sort({ createdAt: -1 })
//       .limit(MAX_AUDIENCE_CONTACTS)
//       .lean(),
//     Lead.countDocuments(query),
//   ]);
//   return {
//     rows: leadDocs.map((lead) => ({
//       leadId: String(lead._id),
//       name: lead.name || "",
//       phone: lead.phone || "",
//       email: lead.email || "",
//       address: lead.address || "",
//       city: lead.city || "",
//       location: lead.location || "",
//       occupation: lead.occupation || "",
//       budgetMin: lead.budgetMin ?? null,
//       budgetMax: lead.budgetMax ?? null,
//       source: lead.source || "",
//       sourceType: "leads",
//       sourceFile: lead.sourceFile || "",
//       status: "valid",
//       isDuplicate: false,
//       duplicateReason: null,
//       errors: [],
//       createdAt: lead.createdAt || null,
//     })),
//     filterOptions,
//     truncated: totalAvailable > MAX_AUDIENCE_CONTACTS,
//     totalAvailable,
//   };
// }

// /** POST /api/audiences/preview — parse/clean contacts without writing anything. */
// const preview = asyncHandler(async (req, res) => {
//   const method = String(
//     req.body.method || (req.file ? "upload" : "paste"),
//   ).toLowerCase();
//   const addCountryCode = parseBoolean(req.body.addCountryCode, true);
//   let rows = [];
//   let sourceType = "paste";
//   let sourceLabel = "Numbers paste karein";
//   let sourceFileName = "";
//   let filterOptions;
//   let truncated = false;
//   let totalAvailable = null;

//   try {
//     if (method === "upload") {
//       if (!req.file) throw ApiError.badRequest("Excel ya CSV file chunein.");
//       const originalName = String(req.file.originalname || "contacts.csv")
//         .replace(/[\/\\]/g, "_")
//         .slice(0, 255);
//       const lowerName = originalName.toLowerCase();
//       rows = lowerName.endsWith(".xlsx")
//         ? parseExcelBuffer(req.file.buffer)
//         : parseCsvBuffer(req.file.buffer);
//       sourceType = "upload";
//       sourceLabel = originalName;
//       sourceFileName = originalName;
//     } else if (method === "paste") {
//       rows = parseLeadText(req.body.text || "");
//       sourceType = "paste";
//       sourceLabel = "Numbers paste karein";
//     } else if (method === "leads") {
//       const filter = parseJsonField(req.body.filter, {});
//       const built = await buildLeadRows(req.user.id, filter);
//       rows = built.rows;
//       filterOptions = built.filterOptions;
//       truncated = built.truncated;
//       totalAvailable = built.totalAvailable;
//       sourceType = "leads";
//       sourceLabel = filter.sourceFile
//         ? String(filter.sourceFile).slice(0, 255)
//         : "Upload Data se chunein";
//       sourceFileName = filter.sourceFile
//         ? String(filter.sourceFile).slice(0, 255)
//         : "";
//     } else {
//       throw ApiError.badRequest(
//         "Source method upload, paste ya leads hona chahiye.",
//       );
//     }
//   } catch (error) {
//     if (error.statusCode) throw error;
//     throw ApiError.badRequest(
//       error.message ||
//         "Contacts read nahi ho paaye. File/number format check karein.",
//     );
//   }

//   if (rows.length > MAX_AUDIENCE_CONTACTS)
//     throw ApiError.badRequest(
//       `Ek audience mein maximum ${MAX_AUDIENCE_CONTACTS.toLocaleString("en-IN")} contacts preview kar sakte hain.`,
//     );
//   if (!rows.length)
//     throw ApiError.badRequest(
//       "Koi contact nahi mila. File ya pasted numbers check karein.",
//     );

//   rows = normalizeRows(rows, addCountryCode);
//   const analysis = await analyzeRows(req.user.id, rows, {
//     checkExisting: false,
//   });
//   const annotated = analysis.rows.map((row) => ({
//     ...row,
//     sourceType,
//     sourceFileName,
//     leadId: row.leadId || undefined,
//   }));

//   return new ApiResponse(
//     200,
//     {
//       rows: annotated,
//       summary: {
//         total: analysis.summary.total,
//         valid: analysis.summary.valid,
//         duplicates: analysis.summary.duplicate,
//         invalid: analysis.summary.invalid,
//       },
//       sourceType,
//       sourceLabel,
//       sourceFileName,
//       addCountryCode,
//       ...(filterOptions ? { filterOptions } : {}),
//       ...(sourceType === "leads" ? { truncated, totalAvailable } : {}),
//       maxContacts: MAX_AUDIENCE_CONTACTS,
//     },
//     "Audience preview ready",
//   ).send(res);
// });

// /** POST /api/audiences — save a reviewed audience and resolve all rows to Leads. */
// const create = asyncHandler(async (req, res) => {
//   const name = String(req.body.name || "").trim();
//   const sourceType = String(req.body.sourceType || "").toLowerCase();
//   const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
//   const tags = [
//     ...new Set(
//       (Array.isArray(req.body.tags) ? req.body.tags : [])
//         .map((tag) =>
//           String(tag || "")
//             .trim()
//             .slice(0, 40),
//         )
//         .filter(Boolean),
//     ),
//   ].slice(0, 20);
//   const addToCrm = parseBoolean(req.body.addToCrm, true);
//   const addCountryCode = parseBoolean(req.body.addCountryCode, true);
//   const sourceFileName = String(req.body.sourceFileName || "")
//     .replace(/[\/\\]/g, "_")
//     .slice(0, 255);
//   const sourceLabel = String(req.body.sourceLabel || "")
//     .trim()
//     .slice(0, 255);

//   if (!name) throw ApiError.badRequest("Audience ka naam zaroori hai.");
//   if (name.length > 120)
//     throw ApiError.badRequest(
//       "Audience ka naam 120 characters se chhota rakhein.",
//     );
//   if (!["upload", "paste", "leads"].includes(sourceType))
//     throw ApiError.badRequest("Audience source valid nahi hai.");
//   if (!rows.length)
//     throw ApiError.badRequest(
//       "Save karne se pehle valid contacts preview karein.",
//     );
//   if (rows.length > MAX_AUDIENCE_CONTACTS)
//     throw ApiError.badRequest(
//       `Ek audience mein maximum ${MAX_AUDIENCE_CONTACTS.toLocaleString("en-IN")} contacts ho sakte hain.`,
//     );

//   // Only rows marked valid in the preview become recipients. Duplicate and
//   // invalid rows remain available in the invalid/summary snapshot, not the list.
//   const validRows = rows.filter(
//     (row) => row?.status === "valid" && !row?.isDuplicate,
//   );
//   const duplicates = rows.filter(
//     (row) => row?.status === "duplicate" || row?.isDuplicate,
//   ).length;
//   const invalidRows = rows
//     .filter((row) => row?.status === "invalid")
//     .map((row) => ({
//       rowNumber: Number(row.rowNumber) || null,
//       name: String(row.name || "").slice(0, 150),
//       phone: String(row.phone || "").slice(0, 80),
//       email: String(row.email || "").slice(0, 255),
//       reason: String(
//         row.duplicateReason ||
//           (Array.isArray(row.errors) ? row.errors.join("; ") : "") ||
//           "Invalid contact",
//       ).slice(0, 500),
//     }));
//   if (!validRows.length)
//     throw ApiError.badRequest(
//       "Koi sahi contact nahi hai. Pehle valid number/email wali rows select karein.",
//     );

//   let resolved;
//   try {
//     resolved = await resolveLeadsForRows(req.user.id, validRows, {
//       sourceType,
//       sourceFileName,
//       addToCrm,
//       addCountryCode,
//     });
//   } catch (error) {
//     if (error.statusCode) throw ApiError.badRequest(error.message);
//     throw error;
//   }

//   const leadIds = [...new Set(resolved.leadIds.map(String))]
//     .slice(0, MAX_AUDIENCE_CONTACTS)
//     .map((id) => new mongoose.Types.ObjectId(id));
//   const audience = await Audience.create({
//     ownerId: req.user.id,
//     name: name.slice(0, 120),
//     tags,
//     sourceType,
//     sourceLabel:
//       sourceLabel ||
//       (sourceType === "upload"
//         ? sourceFileName
//         : sourceType === "paste"
//           ? "Numbers paste karein"
//           : "Upload Data se chunein"),
//     sourceFileName,
//     leadIds,
//     counts: {
//       total: rows.length,
//       valid: leadIds.length,
//       duplicates: duplicates + resolved.duplicates,
//       invalid: invalidRows.length + resolved.invalid,
//     },
//     invalidRowCount: invalidRows.length,
//   });

//   if (invalidRows.length) {
//     try {
//       for (let start = 0; start < invalidRows.length; start += 1000) {
//         await AudienceInvalidRow.insertMany(
//           invalidRows.slice(start, start + 1000).map((row) => ({
//             ...row,
//             ownerId: req.user.id,
//             audienceId: audience._id,
//           })),
//           { ordered: false },
//         );
//       }
//     } catch (error) {
//       await AudienceInvalidRow.deleteMany({
//         ownerId: req.user.id,
//         audienceId: audience._id,
//       });
//       await Audience.deleteOne({ _id: audience._id, ownerId: req.user.id });
//       throw error;
//     }
//   }

//   await AuditLog.create({
//     userId: req.user.id,
//     action: "audience.create",
//     entityType: "Audience",
//     entityId: audience._id,
//     meta: { sourceType, count: leadIds.length, addToCrm, sourceFileName },
//     ip: req.ip,
//   });

//   const audienceSummary = audience.toObject();
//   delete audienceSummary.leadIds;
//   audienceSummary.contactCount = leadIds.length;

//   return new ApiResponse(
//     201,
//     {
//       audience: audienceSummary,
//       resolvedCount: leadIds.length,
//       newContactsAddedToCrm: addToCrm,
//       duplicatesSkipped: duplicates + resolved.duplicates,
//       invalidSkipped: invalidRows.length + resolved.invalid,
//       messagesSent: 0,
//     },
//     "Audience save ho gaya. Koi message send nahi hua.",
//   ).send(res);
// });

// /** GET /api/audiences — each audience includes live per-channel sent skip counts. */
// const list = asyncHandler(async (req, res) => {
//   const audiences = await Audience.find({ ownerId: req.user.id })
//     .sort({ createdAt: -1 })
//     .lean();
//   const allLeadIds = [
//     ...new Set(
//       audiences.flatMap((audience) => (audience.leadIds || []).map(String)),
//     ),
//   ];
//   // Chunk large sets: users may have many saved audiences, and a single
//   // giant $in array can exceed MongoDB's BSON command-size limit.
//   const sentRows = [];
//   const ownerObjectId = new mongoose.Types.ObjectId(req.user.id);
//   for (let start = 0; start < allLeadIds.length; start += 20000) {
//     const chunk = allLeadIds
//       .slice(start, start + 20000)
//       .map((id) => new mongoose.Types.ObjectId(id));
//     const rows = await OutboundJob.aggregate([
//       {
//         $match: {
//           ownerId: ownerObjectId,
//           leadId: { $in: chunk },
//           status: "sent",
//           channel: { $in: ["whatsapp", "email"] },
//         },
//       },
//       { $group: { _id: { leadId: "$leadId", channel: "$channel" } } },
//     ]);
//     sentRows.push(...rows);
//   }
//   const sentByChannel = { whatsapp: new Set(), email: new Set() };
//   sentRows.forEach((row) =>
//     sentByChannel[row._id.channel]?.add(String(row._id.leadId)),
//   );
//   const data = audiences.map((audience) => {
//     const ids = [...new Set((audience.leadIds || []).map(String))];
//     const { leadIds: _leadIds, ...audienceSummary } = audience;
//     return {
//       ...audienceSummary,
//       contactCount: ids.length,
//       invalidRowCount: Number(audience.invalidRowCount || 0),
//       counts: {
//         total: ids.length,
//         ...(audience.counts || {}),
//         valid: ids.length,
//       },
//       skipCount: {
//         whatsapp: ids.filter((id) => sentByChannel.whatsapp.has(id)).length,
//         email: ids.filter((id) => sentByChannel.email.has(id)).length,
//       },
//     };
//   });
//   return new ApiResponse(200, { audiences: data }).send(res);
// });

// const getOne = asyncHandler(async (req, res) => {
//   if (!OBJECT_ID_RE.test(String(req.params.id)))
//     throw ApiError.badRequest("Audience ID valid nahi hai.");
//   const audience = await Audience.findOne({
//     _id: req.params.id,
//     ownerId: req.user.id,
//   }).lean();
//   if (!audience) throw ApiError.notFound("Audience nahi mila.");
//   return new ApiResponse(200, { audience }).send(res);
// });

// const getContacts = asyncHandler(async (req, res) => {
//   const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
//   const requestedLimit = Number.parseInt(req.query.limit, 10) || 100;
//   const limit = Math.min(100, Math.max(1, requestedLimit));
//   const audience = await Audience.findOne({
//     _id: req.params.id,
//     ownerId: req.user.id,
//   })
//     .select("name leadIds")
//     .lean();
//   if (!audience) throw ApiError.notFound("Audience nahi mila.");

//   const ids = [...new Set((audience.leadIds || []).map(String))];
//   const pageIds = ids.slice((page - 1) * limit, page * limit);
//   const found = pageIds.length
//     ? await Lead.find({ ownerId: req.user.id, _id: { $in: pageIds } })
//         .select("_id name phone email city")
//         .lean()
//     : [];
//   const byId = new Map(found.map((lead) => [String(lead._id), lead]));
//   const contacts = pageIds.map((id) => byId.get(id)).filter(Boolean);

//   return new ApiResponse(
//     200,
//     {
//       audience: { _id: audience._id, name: audience.name },
//       contacts,
//       total: ids.length,
//       pagination: {
//         page,
//         limit,
//         total: ids.length,
//         totalPages: Math.max(1, Math.ceil(ids.length / limit)),
//       },
//     },
//     "Audience contacts loaded",
//   ).send(res);
// });

// const remove = asyncHandler(async (req, res) => {
//   if (!OBJECT_ID_RE.test(String(req.params.id)))
//     throw ApiError.badRequest("Audience ID valid nahi hai.");
//   const audience = await Audience.findOneAndDelete({
//     _id: req.params.id,
//     ownerId: req.user.id,
//   });
//   if (!audience) throw ApiError.notFound("Audience nahi mila.");
//   await AudienceInvalidRow.deleteMany({
//     ownerId: req.user.id,
//     audienceId: audience._id,
//   });
//   await AuditLog.create({
//     userId: req.user.id,
//     action: "audience.delete",
//     entityType: "Audience",
//     entityId: audience._id,
//     meta: { name: audience.name, count: audience.leadIds.length },
//     ip: req.ip,
//   });
//   return new ApiResponse(
//     200,
//     { deleted: true, id: audience._id },
//     "Audience delete ho gaya. Leads delete nahi hue.",
//   ).send(res);
// });

// const invalidCsv = asyncHandler(async (req, res) => {
//   if (!OBJECT_ID_RE.test(String(req.params.id)))
//     throw ApiError.badRequest("Audience ID valid nahi hai.");
//   const audience = await Audience.findOne({
//     _id: req.params.id,
//     ownerId: req.user.id,
//   })
//     .select("name _id")
//     .lean();
//   if (!audience) throw ApiError.notFound("Audience nahi mila.");
//   const invalidRows = await AudienceInvalidRow.find({
//     ownerId: req.user.id,
//     audienceId: audience._id,
//   })
//     .sort({ rowNumber: 1 })
//     .lean();
//   const parser = new CsvParser({
//     fields: [
//       { label: "Row number", value: "rowNumber" },
//       { label: "Naam", value: "name" },
//       { label: "Mobile", value: "phone" },
//       { label: "Email", value: "email" },
//       { label: "Reason", value: "reason" },
//     ],
//   });
//   const csv = parser.parse(invalidRows);
//   res.setHeader("Content-Type", "text/csv; charset=utf-8");
//   res.setHeader(
//     "Content-Disposition",
//     `attachment; filename="audience-invalid-${String(audience._id)}.csv"`,
//   );
//   return res.send(`\uFEFF${csv}`);
// });

// module.exports = {
//   preview,
//   create,
//   list,
//   getOne,
//   getContacts,
//   remove,
//   invalidCsv,
// };

const { Parser: CsvParser } = require("json2csv");
const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Audience = require("../models/Audience");
const AudienceInvalidRow = require("../models/AudienceInvalidRow");
const Lead = require("../models/Lead");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const EmailMessage = require("../models/EmailMessage");
const Meeting = require("../models/Meeting");
const OutboundJob = require("../models/OutboundJob");
const AuditLog = require("../models/AuditLog");
const {
  parseCsvBuffer,
  parseExcelBuffer,
  parseLeadText,
  analyzeRows,
} = require("../services/csv/leadImporter");
const {
  resolveLeadsForRows,
  MAX_AUDIENCE_CONTACTS,
} = require("../services/audiences/resolveLeadsForRows");

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function parseJsonField(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw ApiError.badRequest("Filter settings valid JSON nahi hain.");
  }
}

function normalizeRows(rows, addCountryCode) {
  return (rows || []).map((row) => {
    const rawDigits = String(row.phone || "").replace(/\D/g, "");
    // Keep invalid digits visible in the preview/CSV so the user can correct
    // them. The resolver drops an invalid optional phone if the row has email.
    const phone =
      rawDigits && addCountryCode && rawDigits.length === 10
        ? `91${rawDigits}`
        : rawDigits;
    return {
      ...row,
      phone,
      email: String(row.email || "")
        .trim()
        .toLowerCase(),
      name: String(row.name || row.naam || "").trim(),
      address: String(row.address || "").trim(),
      occupation: String(
        row.occupation || row.jobTitle || row.designation || "",
      ).trim(),
    };
  });
}

async function getLeadFilterOptions(ownerId) {
  const base = { ownerId, inCrm: { $ne: false } };
  const [cities, jobTitles] = await Promise.all([
    Lead.distinct("city", { ...base, city: { $type: "string", $ne: "" } }),
    Lead.distinct("occupation", {
      ...base,
      occupation: { $type: "string", $ne: "" },
    }),
  ]);
  return {
    cities: cities
      .map((value) => String(value).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500),
    jobTitles: jobTitles
      .map((value) => String(value).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500),
  };
}

async function getRepliedLeadIds(ownerId) {
  const [conversationIds, emailLeadIds] = await Promise.all([
    Conversation.find({ ownerId }).distinct("_id"),
    EmailMessage.find({
      ownerId,
      direction: "inbound",
      kind: "received",
      leadId: { $ne: null },
    }).distinct("leadId"),
  ]);
  const whatsappLeadIds = conversationIds.length
    ? await Message.find({
        conversationId: { $in: conversationIds },
        direction: "inbound",
        sender: "customer",
        leadId: { $ne: null },
      }).distinct("leadId")
    : [];
  return [...new Set([...whatsappLeadIds, ...emailLeadIds].map(String))];
}

async function buildLeadRows(ownerId, rawFilter = {}) {
  const filterOptions = await getLeadFilterOptions(ownerId);
  const query = { ownerId, inCrm: { $ne: false } };
  const selectedIds = Array.isArray(rawFilter.leadIds)
    ? [
        ...new Set(
          rawFilter.leadIds.map(String).filter((id) => OBJECT_ID_RE.test(id)),
        ),
      ].slice(0, MAX_AUDIENCE_CONTACTS)
    : [];

  if (selectedIds.length)
    query._id = {
      $in: selectedIds.map((id) => new mongoose.Types.ObjectId(id)),
    };
  if (rawFilter.status === "hot") query.leadScore = { $gt: 60 };
  if (rawFilter.city)
    query.city = new RegExp(
      `^${String(rawFilter.city)
        .slice(0, 120)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    );
  if (rawFilter.jobTitle)
    query.occupation = new RegExp(
      `^${String(rawFilter.jobTitle)
        .slice(0, 150)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    );

  const dateRange = String(rawFilter.dateRange || "any");
  if (dateRange === "7d" || dateRange === "30d") {
    query.createdAt = {
      $gte: new Date(
        Date.now() - (dateRange === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000,
      ),
    };
  }

  const idAndClauses = [];
  if (selectedIds.length) {
    delete query._id;
    idAndClauses.push({
      _id: { $in: selectedIds.map((id) => new mongoose.Types.ObjectId(id)) },
    });
  }
  if (rawFilter.status === "visit") {
    const visitLeadIds = await Meeting.find({
      ownerId,
      status: { $ne: "cancelled" },
    }).distinct("leadId");
    idAndClauses.push({ _id: { $in: visitLeadIds } });
    delete query._id;
  }
  if (rawFilter.status === "no_reply") {
    const repliedIds = await getRepliedLeadIds(ownerId);
    idAndClauses.push({
      _id: { $nin: repliedIds.map((id) => new mongoose.Types.ObjectId(id)) },
    });
    delete query._id;
  }
  if (idAndClauses.length)
    query.$and = [...(query.$and || []), ...idAndClauses];

  const [leadDocs, totalAvailable] = await Promise.all([
    Lead.find(query)
      .sort({ createdAt: -1 })
      .limit(MAX_AUDIENCE_CONTACTS)
      .lean(),
    Lead.countDocuments(query),
  ]);
  return {
    rows: leadDocs.map((lead) => ({
      leadId: String(lead._id),
      name: lead.name || "",
      phone: lead.phone || "",
      email: lead.email || "",
      address: lead.address || "",
      city: lead.city || "",
      location: lead.location || "",
      occupation: lead.occupation || "",
      budgetMin: lead.budgetMin ?? null,
      budgetMax: lead.budgetMax ?? null,
      source: lead.source || "",
      sourceType: "leads",
      sourceFile: lead.sourceFile || "",
      status: "valid",
      isDuplicate: false,
      duplicateReason: null,
      errors: [],
      createdAt: lead.createdAt || null,
    })),
    filterOptions,
    truncated: totalAvailable > MAX_AUDIENCE_CONTACTS,
    totalAvailable,
  };
}

/** POST /api/audiences/preview — parse/clean contacts without writing anything. */
const preview = asyncHandler(async (req, res) => {
  const method = String(
    req.body.method || (req.file ? "upload" : "paste"),
  ).toLowerCase();
  const addCountryCode = parseBoolean(req.body.addCountryCode, true);
  let rows = [];
  let sourceType = "paste";
  let sourceLabel = "Numbers paste karein";
  let sourceFileName = "";
  let filterOptions;
  let truncated = false;
  let totalAvailable = null;

  try {
    if (method === "upload") {
      if (!req.file) throw ApiError.badRequest("Excel ya CSV file chunein.");
      const originalName = String(req.file.originalname || "contacts.csv")
        .replace(/[\/\\]/g, "_")
        .slice(0, 255);
      const lowerName = originalName.toLowerCase();
      rows = lowerName.endsWith(".xlsx")
        ? parseExcelBuffer(req.file.buffer)
        : parseCsvBuffer(req.file.buffer);
      sourceType = "upload";
      sourceLabel = originalName;
      sourceFileName = originalName;
    } else if (method === "paste") {
      rows = parseLeadText(req.body.text || "");
      sourceType = "paste";
      sourceLabel = "Numbers paste karein";
    } else if (method === "leads") {
      const filter = parseJsonField(req.body.filter, {});
      const built = await buildLeadRows(req.user.id, filter);
      rows = built.rows;
      filterOptions = built.filterOptions;
      truncated = built.truncated;
      totalAvailable = built.totalAvailable;
      sourceType = "leads";
      sourceLabel = "Upload Data se chunein";
    } else {
      throw ApiError.badRequest(
        "Source method upload, paste ya leads hona chahiye.",
      );
    }
  } catch (error) {
    if (error.statusCode) throw error;
    throw ApiError.badRequest(
      error.message ||
        "Contacts read nahi ho paaye. File/number format check karein.",
    );
  }

  if (rows.length > MAX_AUDIENCE_CONTACTS)
    throw ApiError.badRequest(
      `Ek audience mein maximum ${MAX_AUDIENCE_CONTACTS.toLocaleString("en-IN")} contacts preview kar sakte hain.`,
    );
  if (!rows.length)
    throw ApiError.badRequest(
      "Koi contact nahi mila. File ya pasted numbers check karein.",
    );

  rows = normalizeRows(rows, addCountryCode);
  const analysis = await analyzeRows(req.user.id, rows, {
    checkExisting: false,
  });
  const annotated = analysis.rows.map((row) => ({
    ...row,
    sourceType,
    sourceFileName,
    leadId: row.leadId || undefined,
  }));

  return new ApiResponse(
    200,
    {
      rows: annotated,
      summary: {
        total: analysis.summary.total,
        valid: analysis.summary.valid,
        duplicates: analysis.summary.duplicate,
        invalid: analysis.summary.invalid,
      },
      sourceType,
      sourceLabel,
      sourceFileName,
      addCountryCode,
      ...(filterOptions ? { filterOptions } : {}),
      ...(sourceType === "leads" ? { truncated, totalAvailable } : {}),
      maxContacts: MAX_AUDIENCE_CONTACTS,
    },
    "Audience preview ready",
  ).send(res);
});

/** POST /api/audiences — save a reviewed audience and resolve all rows to Leads. */
const create = asyncHandler(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const sourceType = String(req.body.sourceType || "").toLowerCase();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const tags = [
    ...new Set(
      (Array.isArray(req.body.tags) ? req.body.tags : [])
        .map((tag) =>
          String(tag || "")
            .trim()
            .slice(0, 40),
        )
        .filter(Boolean),
    ),
  ].slice(0, 20);
  const addToCrm = parseBoolean(req.body.addToCrm, true);
  const addCountryCode = parseBoolean(req.body.addCountryCode, true);
  const sourceFileName = String(req.body.sourceFileName || "")
    .replace(/[\/\\]/g, "_")
    .slice(0, 255);
  const sourceLabel = String(req.body.sourceLabel || "")
    .trim()
    .slice(0, 255);

  if (!name) throw ApiError.badRequest("Audience ka naam zaroori hai.");
  if (name.length > 120)
    throw ApiError.badRequest(
      "Audience ka naam 120 characters se chhota rakhein.",
    );
  if (!["upload", "paste", "leads"].includes(sourceType))
    throw ApiError.badRequest("Audience source valid nahi hai.");
  if (!rows.length)
    throw ApiError.badRequest(
      "Save karne se pehle valid contacts preview karein.",
    );
  if (rows.length > MAX_AUDIENCE_CONTACTS)
    throw ApiError.badRequest(
      `Ek audience mein maximum ${MAX_AUDIENCE_CONTACTS.toLocaleString("en-IN")} contacts ho sakte hain.`,
    );

  // Only rows marked valid in the preview become recipients. Duplicate and
  // invalid rows remain available in the invalid/summary snapshot, not the list.
  const validRows = rows.filter(
    (row) => row?.status === "valid" && !row?.isDuplicate,
  );
  const duplicates = rows.filter(
    (row) => row?.status === "duplicate" || row?.isDuplicate,
  ).length;
  const invalidRows = rows
    .filter((row) => row?.status === "invalid")
    .map((row) => ({
      rowNumber: Number(row.rowNumber) || null,
      name: String(row.name || "").slice(0, 150),
      phone: String(row.phone || "").slice(0, 80),
      email: String(row.email || "").slice(0, 255),
      reason: String(
        row.duplicateReason ||
          (Array.isArray(row.errors) ? row.errors.join("; ") : "") ||
          "Invalid contact",
      ).slice(0, 500),
    }));
  if (!validRows.length)
    throw ApiError.badRequest(
      "Koi sahi contact nahi hai. Pehle valid number/email wali rows select karein.",
    );

  let resolved;
  try {
    resolved = await resolveLeadsForRows(req.user.id, validRows, {
      sourceType,
      sourceFileName,
      addToCrm,
      addCountryCode,
    });
  } catch (error) {
    if (error.statusCode) throw ApiError.badRequest(error.message);
    throw error;
  }

  const leadIds = [...new Set(resolved.leadIds.map(String))]
    .slice(0, MAX_AUDIENCE_CONTACTS)
    .map((id) => new mongoose.Types.ObjectId(id));
  const audience = await Audience.create({
    ownerId: req.user.id,
    name: name.slice(0, 120),
    tags,
    sourceType,
    sourceLabel:
      sourceLabel ||
      (sourceType === "upload"
        ? sourceFileName
        : sourceType === "paste"
          ? "Numbers paste karein"
          : "Upload Data se chunein"),
    sourceFileName,
    leadIds,
    counts: {
      total: rows.length,
      valid: leadIds.length,
      duplicates: duplicates + resolved.duplicates,
      invalid: invalidRows.length + resolved.invalid,
    },
    invalidRowCount: invalidRows.length,
  });

  if (invalidRows.length) {
    try {
      for (let start = 0; start < invalidRows.length; start += 1000) {
        await AudienceInvalidRow.insertMany(
          invalidRows.slice(start, start + 1000).map((row) => ({
            ...row,
            ownerId: req.user.id,
            audienceId: audience._id,
          })),
          { ordered: false },
        );
      }
    } catch (error) {
      await AudienceInvalidRow.deleteMany({
        ownerId: req.user.id,
        audienceId: audience._id,
      });
      await Audience.deleteOne({ _id: audience._id, ownerId: req.user.id });
      throw error;
    }
  }

  await AuditLog.create({
    userId: req.user.id,
    action: "audience.create",
    entityType: "Audience",
    entityId: audience._id,
    meta: { sourceType, count: leadIds.length, addToCrm, sourceFileName },
    ip: req.ip,
  });

  const audienceSummary = audience.toObject();
  delete audienceSummary.leadIds;
  audienceSummary.contactCount = leadIds.length;

  return new ApiResponse(
    201,
    {
      audience: audienceSummary,
      resolvedCount: leadIds.length,
      newContactsAddedToCrm: addToCrm,
      duplicatesSkipped: duplicates + resolved.duplicates,
      invalidSkipped: invalidRows.length + resolved.invalid,
      messagesSent: 0,
    },
    "Audience save ho gaya. Koi message send nahi hua.",
  ).send(res);
});

/** GET /api/audiences — each audience includes live per-channel sent skip counts. */
const list = asyncHandler(async (req, res) => {
  const audiences = await Audience.find({ ownerId: req.user.id })
    .sort({ createdAt: -1 })
    .lean();
  const allLeadIds = [
    ...new Set(
      audiences.flatMap((audience) => (audience.leadIds || []).map(String)),
    ),
  ];
  // Chunk large sets: users may have many saved audiences, and a single
  // giant $in array can exceed MongoDB's BSON command-size limit.
  const sentRows = [];
  const ownerObjectId = new mongoose.Types.ObjectId(req.user.id);
  for (let start = 0; start < allLeadIds.length; start += 20000) {
    const chunk = allLeadIds
      .slice(start, start + 20000)
      .map((id) => new mongoose.Types.ObjectId(id));
    const rows = await OutboundJob.aggregate([
      {
        $match: {
          ownerId: ownerObjectId,
          leadId: { $in: chunk },
          status: "sent",
          channel: { $in: ["whatsapp", "email"] },
        },
      },
      { $group: { _id: { leadId: "$leadId", channel: "$channel" } } },
    ]);
    sentRows.push(...rows);
  }
  const sentByChannel = { whatsapp: new Set(), email: new Set() };
  sentRows.forEach((row) =>
    sentByChannel[row._id.channel]?.add(String(row._id.leadId)),
  );
  const data = audiences.map((audience) => {
    const ids = [...new Set((audience.leadIds || []).map(String))];
    const { leadIds: _leadIds, ...audienceSummary } = audience;
    return {
      ...audienceSummary,
      contactCount: ids.length,
      invalidRowCount: Number(audience.invalidRowCount || 0),
      counts: {
        total: ids.length,
        ...(audience.counts || {}),
        valid: ids.length,
      },
      skipCount: {
        whatsapp: ids.filter((id) => sentByChannel.whatsapp.has(id)).length,
        email: ids.filter((id) => sentByChannel.email.has(id)).length,
      },
    };
  });
  return new ApiResponse(200, { audiences: data }).send(res);
});

const getOne = asyncHandler(async (req, res) => {
  if (!OBJECT_ID_RE.test(String(req.params.id)))
    throw ApiError.badRequest("Audience ID valid nahi hai.");
  const audience = await Audience.findOne({
    _id: req.params.id,
    ownerId: req.user.id,
  }).lean();
  if (!audience) throw ApiError.notFound("Audience nahi mila.");
  return new ApiResponse(200, { audience }).send(res);
});

/** GET /api/audiences/:id/contacts — return the selected audience's contact preview. */
const getContacts = asyncHandler(async (req, res) => {
  if (!OBJECT_ID_RE.test(String(req.params.id)))
    throw ApiError.badRequest("Audience ID valid nahi hai.");
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const requestedLimit = Number.parseInt(req.query.limit, 10) || 100;
  const limit = Math.min(100, Math.max(1, requestedLimit));

  const audience = await Audience.findOne({
    _id: req.params.id,
    ownerId: req.user.id,
  })
    .select("name leadIds")
    .lean();
  if (!audience) throw ApiError.notFound("Audience nahi mila.");

  const ids = [...new Set((audience.leadIds || []).map(String))];
  const pageIds = ids.slice((page - 1) * limit, page * limit);
  const found = pageIds.length
    ? await Lead.find({ ownerId: req.user.id, _id: { $in: pageIds } })
        .select("_id name phone email city")
        .lean()
    : [];
  const byId = new Map(found.map((lead) => [String(lead._id), lead]));
  // Preserve audience order; never expose leads belonging to another owner.
  const contacts = pageIds.map((id) => byId.get(id)).filter(Boolean);

  return new ApiResponse(
    200,
    {
      audience: { _id: audience._id, name: audience.name },
      contacts,
      total: ids.length,
      pagination: {
        page,
        limit,
        total: ids.length,
        totalPages: Math.max(1, Math.ceil(ids.length / limit)),
      },
    },
    "Audience contacts loaded",
  ).send(res);
});

const remove = asyncHandler(async (req, res) => {
  if (!OBJECT_ID_RE.test(String(req.params.id)))
    throw ApiError.badRequest("Audience ID valid nahi hai.");
  const audience = await Audience.findOneAndDelete({
    _id: req.params.id,
    ownerId: req.user.id,
  });
  if (!audience) throw ApiError.notFound("Audience nahi mila.");
  await AudienceInvalidRow.deleteMany({
    ownerId: req.user.id,
    audienceId: audience._id,
  });
  await AuditLog.create({
    userId: req.user.id,
    action: "audience.delete",
    entityType: "Audience",
    entityId: audience._id,
    meta: { name: audience.name, count: audience.leadIds.length },
    ip: req.ip,
  });
  return new ApiResponse(
    200,
    { deleted: true, id: audience._id },
    "Audience delete ho gaya. Leads delete nahi hue.",
  ).send(res);
});

const invalidCsv = asyncHandler(async (req, res) => {
  if (!OBJECT_ID_RE.test(String(req.params.id)))
    throw ApiError.badRequest("Audience ID valid nahi hai.");
  const audience = await Audience.findOne({
    _id: req.params.id,
    ownerId: req.user.id,
  })
    .select("name _id")
    .lean();
  if (!audience) throw ApiError.notFound("Audience nahi mila.");
  const invalidRows = await AudienceInvalidRow.find({
    ownerId: req.user.id,
    audienceId: audience._id,
  })
    .sort({ rowNumber: 1 })
    .lean();
  const parser = new CsvParser({
    fields: [
      { label: "Row number", value: "rowNumber" },
      { label: "Naam", value: "name" },
      { label: "Mobile", value: "phone" },
      { label: "Email", value: "email" },
      { label: "Reason", value: "reason" },
    ],
  });
  const csv = parser.parse(invalidRows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="audience-invalid-${String(audience._id)}.csv"`,
  );
  return res.send(`\uFEFF${csv}`);
});

module.exports = {
  preview,
  create,
  list,
  getOne,
  getContacts,
  remove,
  invalidCsv,
};
