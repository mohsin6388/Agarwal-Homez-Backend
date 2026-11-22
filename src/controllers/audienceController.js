const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Audience = require("../models/Audience");
const Lead = require("../models/Lead");
const OutboundJob = require("../models/OutboundJob");
const contacted = require("../services/queue/contactedContacts");

function scopeOwnerId(req) {
  if (req.user.role === "admin" && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

/** Only keep ids of leads this owner really has (deleted leads drop out). */
async function ownedLeadIds(ownerId, ids) {
  if (!ids?.length) return [];
  return Lead.find({ ownerId, _id: { $in: ids } }).distinct("_id");
}

/** Per-audience counts the bulk screen shows: total, WhatsApp-ready, email-ready. */
async function withCounts(ownerId, audiences) {
  const allIds = [
    ...new Set(audiences.flatMap((a) => (a.leadIds || []).map(String))),
  ];
  const leads = allIds.length
    ? await Lead.find({ ownerId, _id: { $in: allIds } })
        .select("_id phone email")
        .lean()
    : [];
  const byId = new Map(leads.map((l) => [String(l._id), l]));
  return audiences.map((a) => {
    const members = (a.leadIds || [])
      .map((id) => byId.get(String(id)))
      .filter(Boolean);
    const { leadIds, ...rest } = a;
    return {
      ...rest,
      counts: {
        total: members.length,
        whatsapp: members.filter((l) => l.phone).length,
        email: members.filter((l) => l.email).length,
      },
    };
  });
}

/** GET /api/audiences */
const listAudiences = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const filter = { ownerId };
  if (req.query.search) {
    const escaped = String(req.query.search)
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped)
      filter.$or = [
        { name: new RegExp(escaped, "i") },
        { tags: new RegExp(escaped, "i") },
      ];
  }
  const audiences = await Audience.find(filter)
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean();
  return new ApiResponse(200, {
    audiences: await withCounts(ownerId, audiences),
  }).send(res);
});

/** POST /api/audiences — save selected / uploaded contacts as a reusable audience. */
const createAudience = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { name, description, tags, source, leadIds } = req.body;
  const ids = await ownedLeadIds(ownerId, [...new Set(leadIds)]);
  if (!ids.length)
    throw ApiError.badRequest(
      "Selected contacts nahi mile. List refresh karke dobara chunein.",
    );
  if (await Audience.exists({ ownerId, name }))
    throw ApiError.conflict(
      "Is naam ka audience pehle se hai. Doosra naam rakhein.",
    );
  const audience = await Audience.create({
    ownerId,
    name,
    description,
    tags,
    source,
    leadIds: ids,
  });
  const [result] = await withCounts(ownerId, [audience.toObject()]);
  return new ApiResponse(
    201,
    { audience: result },
    `Audience saved with ${ids.length} contacts`,
  ).send(res);
});

/** GET /api/audiences/:id */
const getAudience = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const audience = await Audience.findOne({
    _id: req.params.id,
    ownerId,
  }).lean();
  if (!audience) throw ApiError.notFound("Audience not found");
  const [result] = await withCounts(ownerId, [audience]);
  return new ApiResponse(200, {
    audience: { ...result, leadIds: audience.leadIds },
  }).send(res);
});

/**
 * GET /api/audiences/:id/leads?channel=whatsapp&excludeSent=1
 * Lead ids ready for a channel; optionally skipping anyone who was already
 * sent a message on that channel.
 */
const getAudienceLeads = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const audience = await Audience.findOne({
    _id: req.params.id,
    ownerId,
  }).lean();
  if (!audience) throw ApiError.notFound("Audience not found");
  const { channel } = req.query;
  const excludeSent = ["1", "true"].includes(
    String(req.query.excludeSent || ""),
  );

  const wantDetails = ["1", "true"].includes(String(req.query.details || ""));
  // Preview list me itne hi rows aate hain (badi audience par response halka rahe);
  // leadIds hamesha poori list ke hote hain, isliye campaign me sab jate hain.
  const PREVIEW_LIMIT = 500;

  const filter = { ownerId, _id: { $in: audience.leadIds } };
  if (channel === "whatsapp") filter.phone = { $type: "string", $ne: "" };
  if (channel === "email") filter.email = { $type: "string", $ne: "" };

  // Ek hi query me leads + (parallel) hidden ids — pehle distinct + dobara find
  // + sequential hidden lookup hota tha, jis se popup der se khulta tha.
  const needHidden = excludeSent && Boolean(channel);
  const [rows, hiddenRaw] = await Promise.all([
    Lead.find(filter)
      .select("_id name phone email address jobTitle createdAt")
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
    !needHidden
      ? Promise.resolve([])
      : channel === "whatsapp"
        ? // Contacts sheet jaisa hi rule — jinko pehle bheja, jinka send fail
          // hua, ya jo kisi campaign ki queue me hain, sab chhupao.
          contacted.getHiddenLeadIds(ownerId)
        : OutboundJob.distinct("leadId", {
            ownerId,
            channel,
            status: "sent",
            leadId: { $in: audience.leadIds },
          }),
  ]);

  const hiddenSet = new Set(hiddenRaw.map(String));
  const ready = needHidden
    ? rows.filter((row) => !hiddenSet.has(String(row._id)))
    : rows;
  const skippedSent = rows.length - ready.length;
  const ids = ready.map((row) => row._id);
  const contacts = wantDetails ? ready.slice(0, PREVIEW_LIMIT) : undefined;

  return new ApiResponse(200, {
    leadIds: ids,
    total: audience.leadIds.length,
    ready: ids.length,
    skippedSent,
    ...(contacts
      ? { contacts, contactsTruncated: ids.length > contacts.length }
      : {}),
  }).send(res);
});

/** PATCH /api/audiences/:id — rename, retag, add or remove contacts. */
const updateAudience = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const audience = await Audience.findOne({ _id: req.params.id, ownerId });
  if (!audience) throw ApiError.notFound("Audience not found");
  const {
    name,
    description,
    tags,
    addLeadIds = [],
    removeLeadIds = [],
  } = req.body;
  if (name && name !== audience.name) {
    if (await Audience.exists({ ownerId, name, _id: { $ne: audience._id } }))
      throw ApiError.conflict("Is naam ka audience pehle se hai.");
    audience.name = name;
  }
  if (description !== undefined) audience.description = description;
  if (tags) audience.tags = tags;
  if (addLeadIds.length || removeLeadIds.length) {
    const current = new Set(audience.leadIds.map(String));
    (await ownedLeadIds(ownerId, addLeadIds)).forEach((id) =>
      current.add(String(id)),
    );
    removeLeadIds.forEach((id) => current.delete(String(id)));
    audience.leadIds = [...current];
  }
  await audience.save();
  const [result] = await withCounts(ownerId, [audience.toObject()]);
  return new ApiResponse(200, { audience: result }, "Audience updated").send(
    res,
  );
});

/** DELETE /api/audiences/:id — removes the list only; contacts stay in Upload Data. */
const deleteAudience = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const audience = await Audience.findOneAndDelete({
    _id: req.params.id,
    ownerId,
  });
  if (!audience) throw ApiError.notFound("Audience not found");
  return new ApiResponse(200, null, "Audience deleted").send(res);
});

module.exports = {
  listAudiences,
  createAudience,
  getAudience,
  getAudienceLeads,
  updateAudience,
  deleteAudience,
};
