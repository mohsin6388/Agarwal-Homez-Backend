const asyncHandler = require("../utils/asyncHandler");
const WhatsAppTemplateAsset = require('../models/WhatsAppTemplateAsset');
const WhatsAppTemplateDraft = require('../models/WhatsAppTemplateDraft');
const mongoose = require('mongoose');
const { uploadBufferToCloudinary } = require('../services/cloudinaryUpload');
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const env = require("../config/env");
const metaWhatsappClient = require("../services/whatsapp/metaWhatsappClient");
const { handleWebhook } = require("../services/whatsapp/webhookHandler");
const settingsService = require("../services/settings/settingsService");
const logger = require("../utils/logger");
const axios = require("axios");

/**
 * GET /api/whatsapp/webhook
 * One-time handshake Meta performs when you register/verify the webhook URL
 * in the Meta App Dashboard (WhatsApp -> Configuration -> Webhook).
 *
 * Meta sends:
 * hub.mode=subscribe
 * hub.verify_token=<the token entered in Meta Dashboard>
 * hub.challenge=<random string>
 *
 * If the token matches, echo hub.challenge back as plain text.
 */

const verifyWebhook = asyncHandler(async (req, res) => {
  // Parse query parameters directly from the request URL.
  // This avoids relying on Express's req.query parser.
  const queryString = (req.originalUrl || req.url).split("?")[1] || "";
  const params = new URLSearchParams(queryString);

  const mode = params.get("hub.mode")?.trim();
  const token = params.get("hub.verify_token")?.trim();
  const challenge = params.get("hub.challenge")?.trim();

  const configuredToken = env.metaWhatsapp.verifyToken;

  if (
    mode === "subscribe" &&
    configuredToken &&
    token === configuredToken &&
    challenge
  ) {
    logger.info("[whatsapp] Webhook verification succeeded");

    return res.status(200).type("text/plain").send(challenge);
  }

  // Do not log the actual verify token.
  logger.warn("[whatsapp] Webhook verification failed", {
    modeReceived: mode || null,
    tokenReceived: Boolean(token),
    tokenConfigured: Boolean(configuredToken),
    challengeReceived: Boolean(challenge),
    requestUrlHasQuery: queryString.length > 0,
  });

  return res.sendStatus(403);
});

// const verifyWebhook = asyncHandler(async (req, res) => {
//   // Express may return an array when query parameters are repeated.
//   const getQueryValue = (value) => {
//     const normalizedValue = Array.isArray(value) ? value[0] : value;

//     return typeof normalizedValue === "string"
//       ? normalizedValue.trim()
//       : normalizedValue;
//   };

//   const mode = getQueryValue(req.query["hub.mode"]);
//   const token = getQueryValue(req.query["hub.verify_token"]);
//   const challenge = getQueryValue(req.query["hub.challenge"]);

//   const configuredToken = env.metaWhatsapp.verifyToken;

//   if (
//     mode === "subscribe" &&
//     configuredToken &&
//     token === configuredToken &&
//     challenge
//   ) {
//     logger.info("[whatsapp] Webhook verification succeeded");
//     return res.status(200).type("text/plain").send(challenge);
//   }

//   // Never log the actual verify token.
//   logger.warn("[whatsapp] Webhook verification failed", {
//     modeReceived: mode,
//     tokenReceived: Boolean(token),
//     tokenConfigured: Boolean(configuredToken),
//     challengeReceived: Boolean(challenge),
//     tokenType: Array.isArray(req.query["hub.verify_token"])
//       ? "array"
//       : typeof req.query["hub.verify_token"],
//   });

//   return res.sendStatus(403);
// });

/**
 * POST /api/whatsapp/webhook
 * Public endpoint (no auth) — this is the URL you register in the Meta App
 * Dashboard under WhatsApp -> Configuration -> Webhook, subscribed to the
 * "messages" field.
 *
 * Always responds 200 quickly; Meta retries on anything else.
 */
const receiveWebhook = asyncHandler(async (req, res) => {
  logger.info(`[whatsapp] Webhook hit: object=${req.body?.object}`);

  // Respond immediately. AI processing may take longer than Meta's
  // expected webhook response time.
  res.status(200).json({ ok: true });

  handleWebhook(req.body).catch((err) =>
    logger.error("[whatsapp] Unhandled webhook processing error", {
      error: err.message,
    }),
  );
});

/**
 * POST /api/whatsapp/webhook/forward
 *
 * Optional bridge for deployments where the SAME Meta App webhook is already
 * owned by n8n. n8n can forward the raw Meta JSON to this endpoint with
 * X-PropAI-Webhook-Secret.
 *
 * This endpoint intentionally does not require a user JWT because it is
 * machine-to-machine. Keep the secret private.
 */
const receiveForwardedWebhook = asyncHandler(async (req, res) => {
  if (!env.metaWhatsapp.forwardSecret) {
    return res.sendStatus(404);
  }

  const supplied = req.get("X-PropAI-Webhook-Secret");

  if (!supplied || supplied !== env.metaWhatsapp.forwardSecret) {
    return res.sendStatus(401);
  }

  logger.info(`[whatsapp] Forwarded webhook hit: object=${req.body?.object}`);

  res.status(200).json({ ok: true });

  handleWebhook(req.body).catch((err) =>
    logger.error("[whatsapp] Unhandled forwarded webhook processing error", {
      error: err.message,
    }),
  );
});

/**
 * POST /api/whatsapp/send-test
 *
 * Manual/dev utility to confirm the Meta WhatsApp Cloud API integration can
 * actually send.
 *
 * Like every free-text send, this only works within 24h of the target number
 * having messaged your WhatsApp number at least once.
 *
 * Use send-test-template below to reach a brand-new number.
 */
const sendTest = asyncHandler(async (req, res) => {
  const { phone, text } = req.body;

  if (!phone || !text) {
    throw ApiError.badRequest("phone and text are required");
  }

  const settings = await settingsService.getOrCreateSettings();

  if (settings.whatsappDisconnected) {
    throw ApiError.badRequest(
      "WhatsApp is disconnected for your account — reconnect it from Settings first",
    );
  }

  const { messageId } = await metaWhatsappClient.sendTextMessage({
    phone,
    text,
  });

  return new ApiResponse(200, { messageId }, "Message sent").send(res);
});

/**
 * POST /api/whatsapp/send-test-template
 *
 * Dev utility to send the configured opening TEMPLATE to any number,
 * bypassing the 24h window rule.
 *
 * Useful to confirm the approved template works before wiring it into the
 * real lead-creation flow.
 */
const sendTestTemplate = asyncHandler(async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    throw ApiError.badRequest("phone is required");
  }

  const settings = await settingsService.getOrCreateSettings();

  const templateName =
    settings.openingTemplate?.name || env.metaWhatsapp.openingTemplateName;

  const templateLanguage =
    settings.openingTemplate?.language ||
    env.metaWhatsapp.openingTemplateLanguage;

  if (!templateName) {
    throw ApiError.badRequest(
      "No approved WhatsApp opening template is configured",
    );
  }

  const { messageId } = await metaWhatsappClient.sendTemplateMessage({
    phone,
    templateName,
    languageCode: templateLanguage,
  });

  return new ApiResponse(200, { messageId }, "Template message sent").send(res);
});

/**
 * GET /api/whatsapp/diagnostics
 *
 * Verifies the configured sender and WABA mapping.
 */
const diagnostics = asyncHandler(async (req, res) => {
  const configured = Boolean(
    env.metaWhatsapp.accessToken &&
    env.metaWhatsapp.phoneNumberId &&
    env.metaWhatsapp.businessAccountId,
  );

  if (!configured) {
    throw ApiError.badRequest("Meta WhatsApp credentials are incomplete");
  }

  try {
    const result = await metaWhatsappClient.verifyConfiguration();

    return new ApiResponse(
      200,
      {
        provider: "meta_cloud_api",
        apiVersion: env.metaWhatsapp.apiVersion,
        phoneNumberId: env.metaWhatsapp.phoneNumberId,
        businessAccountId: env.metaWhatsapp.businessAccountId,
        phoneNumberBelongsToWaba: result.phoneNumberBelongsToWaba,
        sender: result.account,
        wabaPhoneNumbers: result.wabaPhoneNumbers,
      },
      "Meta WhatsApp configuration verified",
    ).send(res);
  } catch (err) {
    return new ApiResponse(
      502,
      {
        provider: "meta_cloud_api",
        phoneNumberId: env.metaWhatsapp.phoneNumberId,
        businessAccountId: env.metaWhatsapp.businessAccountId,
        ok: false,
        metaError: err.metaError ||
          err.response?.data?.error || {
            message: err.message,
            code: err.code,
          },
      },
      "Meta WhatsApp configuration verification failed",
    ).send(res);
  }
});

/**
 * GET /api/whatsapp/status
 *
 * Reports whether Meta WhatsApp Cloud API is configured, the connected
 * number (best-effort, straight from Meta), and whether this org has hit
 * "Disconnect" on the Settings page.
 */
const getStatus = asyncHandler(async (req, res) => {
  const configured = Boolean(
    env.metaWhatsapp.accessToken && env.metaWhatsapp.phoneNumberId,
  );

  const settings = await settingsService.getOrCreateSettings();

  let phoneNumber = null;
  let verifiedName = null;
  let liveStatus = null;
  let qualityRating = null;

  if (configured) {
    try {
      const info = await metaWhatsappClient.getAccountInfo();

      phoneNumber = info.phoneNumber;
      verifiedName = info.verifiedName;
      liveStatus = info.status;
      qualityRating = info.qualityRating;
    } catch (err) {
      logger.warn(
        "[whatsapp] Could not fetch Meta account info for status page",
        {
          error: err.response?.data || err.message,
        },
      );
    }
  }

  return new ApiResponse(200, {
    provider: "meta_cloud_api",
    configured,
    phoneNumberId: configured ? env.metaWhatsapp.phoneNumberId : null,
    businessAccountId: env.metaWhatsapp.businessAccountId,
    apiVersion: env.metaWhatsapp.apiVersion,
    phoneNumber,
    verifiedName,
    liveStatus,
    qualityRating,
    openingTemplateConfigured: Boolean(
      settings.openingTemplate?.name || env.metaWhatsapp.openingTemplateName,
    ),
    openingTemplateName:
      settings.openingTemplate?.name ||
      env.metaWhatsapp.openingTemplateName ||
      null,
    openingTemplateLanguage:
      settings.openingTemplate?.language ||
      env.metaWhatsapp.openingTemplateLanguage,
    disconnected: settings.whatsappDisconnected,
  }).send(res);
});

/**
 * POST /api/whatsapp/disconnect
 *
 * Stops AI auto-replies and manual/test sends for this org.
 * Does NOT touch the underlying Meta WhatsApp number.
 */
const disconnect = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({
    whatsappDisconnected: true,
  });

  return new ApiResponse(200, { settings }, "WhatsApp disconnected").send(res);
});

/**
 * POST /api/whatsapp/reconnect
 */
const reconnect = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings({
    whatsappDisconnected: false,
  });

  return new ApiResponse(200, { settings }, "WhatsApp reconnected").send(res);
});

async function fetchMetaTemplates() {
  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.businessAccountId) {
    throw ApiError.badRequest("Meta WhatsApp access token aur Business Account ID configure karein.");
  }
  const all = [];
  let url = `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/message_templates`;
  let params = { fields: "name,language,status,category,components,rejected_reason", limit: 100 };
  // A few bounded pages are enough for this client's template catalogue and avoid an unbounded API loop.
  for (let page = 0; url && page < 5; page += 1) {
    const response = await axios.get(url, {
      params,
      headers: { Authorization: `Bearer ${env.metaWhatsapp.accessToken}` },
      timeout: 15000,
    });
    all.push(...(response.data?.data || []));
    url = response.data?.paging?.next || null;
    params = undefined;
  }
  return all.map((item) => ({
    id: item.id || null,
    name: item.name,
    language: item.language,
    category: item.category || "",
    status: item.status || "UNKNOWN",
    rejected_reason: item.rejected_reason || item.rejectedReason || "",
    components: item.components || [],
  }));
}


async function addTemplateAssets(templates, ownerId) {
  const assets = await WhatsAppTemplateAsset.find({ ownerId }).lean();
  const byKey = new Map(assets.map((asset) => [`${asset.name}::${asset.language}`, asset]));
  return templates.map((template) => {
    const asset = byKey.get(`${template.name}::${template.language}`);
    const header = (template.components || []).find((part) => String(part.type).toUpperCase() === 'HEADER');
    const headerFormat = String(header?.format || '').toLowerCase();
    const assetHeaderType = String(asset?.headerType || '').toLowerCase();
    const inferredHeaderType = assetHeaderType && assetHeaderType !== 'none'
      ? assetHeaderType
      : (headerFormat === 'text' || headerFormat === 'image' || headerFormat === 'document' ? headerFormat : (asset?.imageUrl ? 'image' : 'none'));
    return {
      ...template,
      imageUrl: asset?.imageUrl || '',
      headerType: inferredHeaderType,
      headerText: asset?.headerText || (headerFormat === 'text' ? header?.text || '' : ''),
      headerDocumentUrl: asset?.documentUrl || '',
      headerFileName: asset?.headerFileName || '',
      footerText: asset?.footerText || ((template.components || []).find((part) => String(part.type).toUpperCase() === 'FOOTER')?.text || ''),
      buttons: asset?.buttons?.length ? asset.buttons : ((template.components || []).find((part) => String(part.type).toUpperCase() === 'BUTTONS')?.buttons || []),
      bodyText: asset?.bodyText || ((template.components || []).find((part) => String(part.type).toUpperCase() === 'BODY')?.text || ''),
    };
  });
}

async function uploadTemplateAssetToMeta(assetUrl, kind = 'image') {
  if (!env.metaWhatsapp.appId) throw ApiError.badRequest('Meta template media upload ke liye META_APP_ID configure karein.');
  let parsedUrl;
  try { parsedUrl = new URL(assetUrl); } catch { throw ApiError.badRequest('Header asset ka public HTTPS URL valid hona chahiye.'); }
  if (parsedUrl.protocol !== 'https:' || !['res.cloudinary.com', 'cloudinary.com'].includes(parsedUrl.hostname.toLowerCase())) {
    throw ApiError.badRequest('Template header file pehle is app se upload karein; Cloudinary HTTPS URL required hai.');
  }
  const isDocument = kind === 'document';
  const maxBytes = isDocument ? 30 * 1024 * 1024 : 5 * 1024 * 1024;
  const assetResponse = await axios.get(assetUrl, { responseType: 'arraybuffer', timeout: 25000, maxContentLength: maxBytes + 1 });
  const buffer = Buffer.from(assetResponse.data);
  const responseMime = String(assetResponse.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!isDocument && responseMime && !responseMime.startsWith('image/')) throw ApiError.badRequest('Template header URL par valid image nahi mili.');
  const mime = isDocument ? 'application/pdf' : (responseMime.startsWith('image/') ? responseMime : 'image/jpeg');
  if (isDocument && responseMime && !['application/pdf', 'application/octet-stream', 'binary/octet-stream'].includes(responseMime)) {
    throw ApiError.badRequest('PDF header URL par PDF file nahi mili.');
  }
  if (!isDocument && !mime.startsWith('image/')) throw ApiError.badRequest('Template header par valid image nahi mili.');
  if (buffer.length > maxBytes) throw ApiError.badRequest(isDocument ? 'Template PDF 30 MB se chhoti honi chahiye.' : 'Meta template header image 5 MB se chhoti honi chahiye.');
  const init = await axios.post(`https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.appId}/uploads`, null, {
    params: { file_length: buffer.length, file_type: mime, access_token: env.metaWhatsapp.accessToken }, timeout: 20000,
  });
  const sessionId = init.data?.id;
  if (!sessionId) throw ApiError.badRequest('Meta upload session create nahi hui. META_APP_ID aur token permissions check karein.');
  const uploaded = await axios.post(`https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${sessionId}`, buffer, {
    headers: { Authorization: `OAuth ${env.metaWhatsapp.accessToken}`, 'Content-Type': 'application/octet-stream', file_offset: '0' }, timeout: 30000, maxBodyLength: maxBytes + 1024,
  });
  const handle = uploaded.data?.h;
  if (!handle) throw ApiError.badRequest('Meta se template media handle nahi mila.');
  return handle;
}

// Compatibility wrapper for any legacy callers/tests that still use the image helper.
async function uploadTemplateImageToMeta(imageUrl) {
  return uploadTemplateAssetToMeta(imageUrl, 'image');
}

const TEMPLATE_SAMPLE_DEFAULTS = ['Ayush', 'Kanpur', '₹80 lakh – ₹85 lakh', '2 BHK', 'Agarwal Homez', 'next week'];

function normalizeTemplateButtons(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw ApiError.badRequest('Buttons ki list valid honi chahiye.');
  if (value.length > 3) throw ApiError.badRequest('Maximum 3 quick-reply buttons add kar sakte hain.');
  return value.map((button) => {
    const text = String(button?.text || '').trim();
    if (!text) throw ApiError.badRequest('Quick-reply button ka text required hai.');
    if (text.length > 25) throw ApiError.badRequest('Quick-reply button text 25 characters ya usse kam hona chahiye.');
    const type = String(button?.type || 'QUICK_REPLY').toUpperCase();
    if (type !== 'QUICK_REPLY') throw ApiError.badRequest('Is builder mein sirf QUICK_REPLY buttons supported hain.');
    return { type: 'QUICK_REPLY', text };
  });
}

function makeDraftTemplate(draft) {
  const components = [];
  if (draft.headerType === 'text' && draft.headerText) components.push({ type: 'HEADER', format: 'TEXT', text: draft.headerText });
  if (draft.headerType === 'image') components.push({ type: 'HEADER', format: 'IMAGE' });
  if (draft.headerType === 'document') components.push({ type: 'HEADER', format: 'DOCUMENT' });
  if (draft.bodyText) components.push({ type: 'BODY', text: draft.bodyText });
  if (draft.footerText) components.push({ type: 'FOOTER', text: draft.footerText });
  if (draft.buttons?.length) components.push({ type: 'BUTTONS', buttons: draft.buttons });
  return {
    ...draft,
    id: String(draft._id),
    _id: String(draft._id),
    isDraft: true,
    status: 'DRAFT',
    rejected_reason: '',
    components,
    imageUrl: draft.headerImageUrl || '',
    bodyText: draft.bodyText || '',
  };
}

function normalizeDraftPayload(body = {}) {
  const category = String(body.category || 'MARKETING').toUpperCase();
  const language = String(body.language || 'hi').trim();
  const headerTypeRaw = String(body.headerType || '').toLowerCase();
  const headerType = ['none', 'text', 'image', 'document'].includes(headerTypeRaw)
    ? headerTypeRaw
    : (body.headerDocumentUrl ? 'document' : body.headerImageUrl ? 'image' : body.headerText ? 'text' : 'none');
  if (!['MARKETING', 'UTILITY'].includes(category)) throw ApiError.badRequest('Category Marketing ya Utility honi chahiye.');
  if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(language)) throw ApiError.badRequest('Language code e.g. hi ya en_US use karein.');
  if (headerType === 'text' && String(body.headerText || '').length > 60) throw ApiError.badRequest('Header text maximum 60 characters ka ho sakta hai.');
  if (String(body.footerText || '').length > 60) throw ApiError.badRequest('Footer maximum 60 characters ka ho sakta hai.');
  if (String(body.bodyText || '').length > 1024) throw ApiError.badRequest('Message maximum 1,024 characters ka ho sakta hai.');
  return {
    name: String(body.name || '').trim().toLowerCase().slice(0, 512),
    category,
    language,
    headerType,
    headerText: headerType === 'text' ? String(body.headerText || '').trim() : '',
    headerImageUrl: headerType === 'image' ? String(body.headerImageUrl || '').trim() : '',
    headerDocumentUrl: headerType === 'document' ? String(body.headerDocumentUrl || '').trim() : '',
    headerFileName: String(body.headerFileName || '').trim().slice(0, 180),
    bodyText: String(body.bodyText || '').trim(),
    footerText: String(body.footerText || '').trim(),
    buttons: normalizeTemplateButtons(body.buttons),
    sampleValues: Array.isArray(body.sampleValues) ? body.sampleValues.slice(0, 10).map((value) => String(value || '').trim().slice(0, 200)) : [],
  };
}

/** POST /api/whatsapp/templates/upload-header — Cloudinary image/PDF upload. */
const uploadTemplateHeader = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Header ke liye image ya PDF file select karein.');
  const mime = String(req.file.mimetype || '').toLowerCase();
  const isDocument = mime === 'application/pdf' || String(req.file.originalname || '').toLowerCase().endsWith('.pdf');
  const resourceType = isDocument ? 'raw' : 'image';
  try {
    const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
      folder: 'templates/whatsapp',
      resourceType,
    });
    return new ApiResponse(201, {
      url: uploaded.secure_url,
      publicId: uploaded.public_id,
      resourceType,
      kind: isDocument ? 'document' : 'image',
      fileName: String(req.file.originalname || (isDocument ? 'brochure.pdf' : 'header-image')).slice(0, 180),
      bytes: uploaded.bytes || req.file.size,
    }, 'Template header file upload ho gayi.').send(res);
  } catch (err) {
    logger.error('[whatsapp] Template header upload failed', { error: err.message });
    throw new ApiError(502, err?.message || 'Template header upload nahi hui. Cloudinary configuration check karein.');
  }
});

/** POST /api/whatsapp/templates/drafts — create or update an owner-scoped draft. */
const saveTemplateDraft = asyncHandler(async (req, res) => {
  const payload = normalizeDraftPayload(req.body || {});
  const draftId = String(req.body?.draftId || req.body?._id || '').trim();
  let draft;
  if (draftId) {
    if (!mongoose.Types.ObjectId.isValid(draftId)) throw ApiError.badRequest('Draft ID valid nahi hai.');
    draft = await WhatsAppTemplateDraft.findOneAndUpdate(
      { _id: draftId, ownerId: req.user.id },
      { $set: payload },
      { new: true, runValidators: true },
    );
    if (!draft) throw ApiError.notFound('Draft nahi mila ya aapko access nahi hai.');
  } else {
    draft = await WhatsAppTemplateDraft.create({ ...payload, ownerId: req.user.id });
  }
  return new ApiResponse(200, { draft: makeDraftTemplate(draft.toObject()) }, 'Draft save ho gaya.').send(res);
});

/** GET /api/whatsapp/templates/drafts — the signed-in owner's drafts only. */
const listTemplateDrafts = asyncHandler(async (req, res) => {
  const drafts = await WhatsAppTemplateDraft.find({ ownerId: req.user.id }).sort({ updatedAt: -1 }).lean();
  return new ApiResponse(200, { drafts: drafts.map(makeDraftTemplate) }, 'Template drafts loaded').send(res);
});

/** DELETE /api/whatsapp/templates/drafts/:id */
const deleteTemplateDraft = asyncHandler(async (req, res) => {
  const draftId = String(req.params.id || '').trim();
  if (!mongoose.Types.ObjectId.isValid(draftId)) throw ApiError.badRequest('Draft ID valid nahi hai.');
  const result = await WhatsAppTemplateDraft.deleteOne({ _id: draftId, ownerId: req.user.id });
  if (!result.deletedCount) throw ApiError.notFound('Draft nahi mila ya aapko access nahi hai.');
  return new ApiResponse(200, { deleted: true, id: draftId }, 'Draft delete ho gaya.').send(res);
});

/** DELETE /api/whatsapp/templates/:name — delete a Meta template by name. */
const deleteTemplate = asyncHandler(async (req, res) => {
  const name = String(req.params?.name || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name)) {
    throw ApiError.badRequest('Invalid template name.');
  }
  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.businessAccountId) {
    throw ApiError.badRequest('Meta WhatsApp access token aur Business Account ID configure karein.');
  }

  try {
    await axios.delete(
      `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/message_templates`,
      {
        params: { name },
        headers: { Authorization: `Bearer ${env.metaWhatsapp.accessToken}` },
        timeout: 15000,
      },
    );
    await WhatsAppTemplateAsset.deleteMany({ ownerId: req.user.id, name });
    return new ApiResponse(200, { deleted: true, name }, 'WhatsApp template deleted from Meta').send(res);
  } catch (err) {
    const metaError = err.response?.data?.error;
    logger.warn('[whatsapp] Template delete failed', { name, error: metaError || err.message });
    throw new ApiError(err.response?.status && err.response.status < 500 ? 400 : 502,
      metaError?.error_user_msg || metaError?.message || 'Meta template delete nahi ho paya. Permissions aur template name check karein.',
      metaError || null);
  }
});

/** GET /api/whatsapp/templates — approved templates only, used by the sender. */
const listApprovedTemplates = asyncHandler(async (req, res) => {
  try {
    const templates = await addTemplateAssets((await fetchMetaTemplates()).filter((item) => String(item.status).toUpperCase() === "APPROVED"), req.user.id);
    return new ApiResponse(200, { templates, configured: true }, "Approved templates loaded").send(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const metaError = err.response?.data?.error;
    logger.error("[whatsapp] Could not list approved templates", { error: metaError || err.message });
    throw new ApiError(502, metaError?.message || "Meta templates could not be loaded. Check WhatsApp permissions and WABA ID.");
  }
});

/** GET /api/whatsapp/templates/all — status catalogue for the Template Manager. */
const listAllTemplates = asyncHandler(async (req, res) => {
  let metaTemplates = [];
  let configured = Boolean(env.metaWhatsapp.accessToken && env.metaWhatsapp.businessAccountId);
  if (configured) {
    try {
      metaTemplates = await fetchMetaTemplates();
    } catch (err) {
      const metaError = err.response?.data?.error;
      logger.error('[whatsapp] Could not list template catalogue from Meta', { error: metaError || err.message });
      throw new ApiError(502, metaError?.message || 'Meta templates load nahi hue. WhatsApp permissions aur WABA ID check karein.');
    }
  }
  const templates = await addTemplateAssets(metaTemplates, req.user.id);
  const drafts = await WhatsAppTemplateDraft.find({ ownerId: req.user.id }).sort({ updatedAt: -1 }).lean();
  templates.push(...drafts.map(makeDraftTemplate));
  return new ApiResponse(200, {
    templates,
    configured,
    metaUnavailableMessage: configured ? '' : 'Meta credentials configure nahi hain. Saved drafts phir bhi available hain.',
  }, 'WhatsApp templates loaded').send(res);
});

/** POST /api/whatsapp/templates — create a template in Meta and submit it for review. */
const createTemplate = asyncHandler(async (req, res) => {
  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.businessAccountId) {
    throw ApiError.badRequest('Meta WhatsApp access token aur Business Account ID configure karein.');
  }
  const normalized = normalizeDraftPayload(req.body || {});
  const name = normalized.name;
  const { category, language, bodyText, headerText, headerImageUrl, headerDocumentUrl, headerType, footerText, buttons } = normalized;
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name) || name.length > 512) {
    throw ApiError.badRequest('Template ka naam lowercase letters/numbers aur single underscores mein hona chahiye (e.g. property_offer_2026).');
  }
  if (!bodyText || bodyText.length > 1024) throw ApiError.badRequest('Message body required hai aur 1,024 characters se zyada nahi ho sakta.');
  const bodyIndexes = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  if (bodyIndexes.some((value) => value < 1)) throw ApiError.badRequest('Template variables {{1}}, {{2}} jaise format mein honi chahiye.');
  const uniqueIndexes = [...new Set(bodyIndexes)].sort((a, b) => a - b);
  if (uniqueIndexes.some((value, index) => value !== index + 1)) throw ApiError.badRequest('Template variables sequential honi chahiye: {{1}}, {{2}}, {{3}} without gaps.');

  const components = [];
  if (headerType === 'image') {
    if (!headerImageUrl) throw ApiError.badRequest('Photo header select kiya hai; pehle image upload karein.');
    const headerHandle = await uploadTemplateAssetToMeta(headerImageUrl, 'image');
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [headerHandle] } });
  } else if (headerType === 'document') {
    if (!headerDocumentUrl) throw ApiError.badRequest('PDF/Brochure header select kiya hai; pehle PDF upload karein.');
    const headerHandle = await uploadTemplateAssetToMeta(headerDocumentUrl, 'document');
    components.push({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [headerHandle] } });
  } else if (headerType === 'text') {
    if (!headerText) throw ApiError.badRequest('Text header select kiya hai; header text likhein.');
    components.push({ type: 'HEADER', format: 'TEXT', text: headerText });
  }

  const bodyComponent = { type: 'BODY', text: bodyText };
  const variableCount = bodyIndexes.length ? Math.max(...bodyIndexes) : 0;
  if (variableCount > 0) {
    const overrides = normalized.sampleValues;
    const samples = Array.from({ length: variableCount }, (_, index) => {
      return String(overrides[index] || TEMPLATE_SAMPLE_DEFAULTS[index] || `Sample ${index + 1}`).trim();
    });
    bodyComponent.example = { body_text: [samples] };
  }
  components.push(bodyComponent);
  if (footerText) components.push({ type: 'FOOTER', text: footerText });
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });

  try {
    const response = await axios.post(
      `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${env.metaWhatsapp.businessAccountId}/message_templates`,
      { name, language, category, components },
      { headers: { Authorization: `Bearer ${env.metaWhatsapp.accessToken}`, 'Content-Type': 'application/json' }, timeout: 20000 },
    );
    const created = response.data || {};
    await WhatsAppTemplateAsset.findOneAndUpdate(
      { ownerId: req.user.id, name, language },
      { $set: {
        imageUrl: headerType === 'image' ? headerImageUrl : '',
        headerType,
        headerText: headerType === 'text' ? headerText : '',
        documentUrl: headerType === 'document' ? headerDocumentUrl : '',
        headerFileName: normalized.headerFileName || '',
        footerText,
        buttons,
        bodyText,
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );
    const draftId = String(req.body?.draftId || '').trim();
    if (mongoose.Types.ObjectId.isValid(draftId)) {
      await WhatsAppTemplateDraft.deleteOne({ _id: draftId, ownerId: req.user.id });
    }
    return new ApiResponse(201, {
      template: {
        id: created.id || null, name, language, category,
        status: created.status || 'PENDING', components,
        imageUrl: headerType === 'image' ? headerImageUrl : '',
        headerType, headerText, headerDocumentUrl,
        headerFileName: normalized.headerFileName, footerText, buttons, bodyText,
      },
      meta: created,
    }, 'Template Meta ko approval ke liye submit ho gaya. Approval status kuch samay baad refresh karein.').send(res);
  } catch (err) {
    const metaError = err.response?.data?.error;
    logger.warn('[whatsapp] Template creation failed', { name, category, error: metaError || err.message });
    throw new ApiError(err.response?.status && err.response.status < 500 ? 400 : 502,
      metaError?.error_user_msg || metaError?.message || 'Meta template submit nahi ho paya. Permissions aur template fields check karein.', metaError || null);
  }
});

module.exports = {
  verifyWebhook,
  receiveWebhook,
  receiveForwardedWebhook,
  sendTest,
  sendTestTemplate,
  getStatus,
  diagnostics,
  disconnect,
  reconnect,
  listApprovedTemplates,
  listAllTemplates,
  createTemplate,
  deleteTemplate,
  uploadTemplateHeader,
  saveTemplateDraft,
  listTemplateDrafts,
  deleteTemplateDraft,
};
