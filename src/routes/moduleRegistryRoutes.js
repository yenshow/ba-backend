const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const moduleRegistryService = require("../services/platform/moduleRegistryService");

const registryEtag = (registry) =>
  `"${crypto.createHash("sha1").update(JSON.stringify(registry)).digest("hex")}"`;

/**
 * GET /api/modules/registry
 */
router.get(
  "/registry",
  authenticate,
  asyncHandler(async (req, res) => {
    const registry = moduleRegistryService.getRegistry();
    const etag = registryEtag(registry);
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.sendSuccess(registry);
  }),
);

module.exports = router;
