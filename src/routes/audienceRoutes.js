// const express = require("express");
// const router = express.Router();
// const authenticate = require("../middlewares/auth");
// const roleGuard = require("../middlewares/roleGuard");
// const validate = require("../middlewares/validate");
// const { uploadCsv } = require("../middlewares/upload");
// const controller = require("../controllers/audienceController");
// const {
//   createAudienceSchema,
//   audienceIdSchema,
// } = require("../validators/audienceValidators");

// router.use(authenticate, roleGuard("broker", "admin"));
// router.post("/preview", uploadCsv.single("file"), controller.preview);
// router.get("/", controller.list);
// router.get("/:id/contacts", validate(audienceIdSchema), controller.getContacts);
// router.post("/", validate(createAudienceSchema), controller.create);
// router.get(
//   "/:id/invalid.csv",
//   validate(audienceIdSchema),
//   controller.invalidCsv,
// );
// router.get("/:id", validate(audienceIdSchema), controller.getOne);
// router.delete("/:id", validate(audienceIdSchema), controller.remove);
// module.exports = router;

const express = require("express");
const router = express.Router();
const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const validate = require("../middlewares/validate");
const { uploadCsv } = require("../middlewares/upload");
const controller = require("../controllers/audienceController");
const {
  createAudienceSchema,
  audienceIdSchema,
} = require("../validators/audienceValidators");

router.use(authenticate, roleGuard("broker", "admin"));
router.post("/preview", uploadCsv.single("file"), controller.preview);
router.get("/", controller.list);
router.get("/:id/contacts", validate(audienceIdSchema), controller.getContacts);
router.post("/", validate(createAudienceSchema), controller.create);
router.get(
  "/:id/invalid.csv",
  validate(audienceIdSchema),
  controller.invalidCsv,
);
router.get("/:id", validate(audienceIdSchema), controller.getOne);
router.delete("/:id", validate(audienceIdSchema), controller.remove);
module.exports = router;
