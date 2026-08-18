/**
 * 門禁保全 API
 */
const express = require("express");
const router = express.Router();
const accessSecurityService = require("../services/accessSecurity/accessSecurityService");
const {
  authenticate,
  requirePermission,
} = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

router.use(authenticate, requirePermission("system.access_security"));

router.get(
  "/sites",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const result = await accessSecurityService.getSites();
    res.sendSuccess(result);
  }),
);

router.get(
  "/main-stations",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const result = await accessSecurityService.getMainStations();
    res.sendSuccess(result);
  }),
);

router.post(
  "/locations/:id/ring",
  requirePermission("system.access_security.ring"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const locationId = parseInt(req.params.id, 10);
    const result = await accessSecurityService.ringLocation(locationId, {
      actorUserId: req.user?.id ?? null,
    });
    res.sendSuccess(result);
  }),
);

module.exports = router;
