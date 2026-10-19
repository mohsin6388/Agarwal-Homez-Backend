const express = require("express");
const router = express.Router();
const authenticate = require("../middlewares/auth");
const {
  uploadImage: uploadImageMiddleware,
  uploadBrochure,
} = require("../middlewares/upload");
const controller = require("../controllers/uploadController");

router.post(
  "/image",
  authenticate,
  uploadImageMiddleware.single("image"),
  controller.uploadImage,
);

// Email composer: direct PDF upload instead of asking the user to paste a URL.
router.post(
  "/email-document",
  authenticate,
  uploadBrochure.single("brochure"),
  controller.uploadEmailDocument,
);

module.exports = router;
