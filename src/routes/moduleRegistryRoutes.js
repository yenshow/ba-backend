const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const moduleRegistryService = require("../services/platform/moduleRegistryService");

/**
 * GET /api/modules/registry
 * - 需認證
 * - 回傳模組 registry（SSOT）：routePrefix / featureKey / permissionCode / category
 */
router.get(
  "/registry",
  authenticate,
  asyncHandler(async (_req, res) => {
    const registry = moduleRegistryService.getRegistry();
    res.sendSuccess(registry);
  }),
);

module.exports = router;

