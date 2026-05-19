const express = require("express");
const router = express.Router();
const permissionService = require("../services/platform/permissionService");
const { authenticate } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");

/** GET /api/permissions/definitions 取得權限定義（樹狀或扁平），需認證 */
router.get(
  "/definitions",
  authenticate,
  asyncHandler(async (req, res) => {
    const tree = req.query.tree === "true";
    const definitions = await permissionService.getDefinitions({ tree });
    res.sendSuccess({ definitions });
  }),
);

module.exports = router;
