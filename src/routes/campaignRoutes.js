const express = require("express");
const router = express.Router();

const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const validate = require("../middlewares/validate");
const c = require("../controllers/campaignController");
const {
  launchCampaignSchema,
  campaignPreviewSchema,
  campaignTestSendSchema,
  campaignIdSchema,
  retrySchema,
} = require("../validators/campaignValidators");

router.use(authenticate, roleGuard("broker", "admin"));

router.post("/launch", validate(launchCampaignSchema), c.launch);
router.post("/preview", validate(campaignPreviewSchema), c.preview);
router.post("/test-send", validate(campaignTestSendSchema), c.testSend);
router.get("/", c.list);
router.get("/:id", validate(campaignIdSchema), c.getOne);
router.post("/:id/pause", validate(campaignIdSchema), c.pause);
router.post("/:id/resume", validate(campaignIdSchema), c.resume);
router.post("/:id/cancel", validate(campaignIdSchema), c.cancel);
router.post("/:id/retry-failed", validate(retrySchema), c.retry);

module.exports = router;
