const path = require("path");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const { uploadBufferToCloudinary } = require("../services/cloudinaryUpload");

const ALLOWED_FOLDERS = new Set([
  "properties/images",
  "templates/whatsapp",
  "templates/email",
]);

function allowedFolder(input, fallback = "properties/images") {
  const folder = String(input || fallback).trim();
  return ALLOWED_FOLDERS.has(folder) ? folder : fallback;
}

const uploadImage = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw ApiError.badRequest("Image file is required (field name: image).");
  }

  const folder = allowedFolder(req.body?.folder);
  try {
    const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
      folder,
      resourceType: "image",
    });

    return new ApiResponse(
      201,
      {
        url: uploaded.secure_url,
        publicId: uploaded.public_id,
        width: uploaded.width,
        height: uploaded.height,
        bytes: uploaded.bytes,
        originalName: req.file.originalname,
      },
      "Image uploaded to Cloudinary",
    ).send(res);
  } catch (err) {
    throw new ApiError(
      502,
      err?.message || "Image upload failed. Check Cloudinary configuration.",
    );
  }
});

/**
 * Upload an email brochure PDF to Cloudinary as a raw asset.
 * The returned HTTPS URL is stored on the campaign snapshot and inserted as
 * a brochure link in each email by the existing durable queue worker.
 */
const uploadEmailDocument = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw ApiError.badRequest('Brochure PDF file is required (field name: "brochure").');
  }

  const originalName = String(req.file.originalname || "brochure.pdf");
  if (
    req.file.mimetype !== "application/pdf" &&
    !originalName.toLowerCase().endsWith(".pdf")
  ) {
    throw ApiError.badRequest("Brochure must be a PDF file.");
  }

  // Raw Cloudinary assets should retain the .pdf extension in the public ID.
  const safeBase = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "property-brochure";
  const publicId = `${safeBase}-${Date.now()}.pdf`;

  try {
    const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
      folder: "templates/email",
      resourceType: "raw",
      publicId,
    });

    return new ApiResponse(
      201,
      {
        url: uploaded.secure_url,
        publicId: uploaded.public_id,
        bytes: uploaded.bytes,
        originalName,
        resourceType: uploaded.resource_type || "raw",
      },
      "Email brochure PDF uploaded to Cloudinary",
    ).send(res);
  } catch (err) {
    throw new ApiError(
      502,
      err?.message || "Brochure upload failed. Check Cloudinary configuration.",
    );
  }
});

module.exports = { uploadImage, uploadEmailDocument };
