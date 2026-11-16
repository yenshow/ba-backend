/**
 * 對講系統 API
 */
const express = require("express");
const router = express.Router();
const intercomService = require("../services/intercom/intercomService");
const {
  authenticate,
  requirePermission,
} = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

router.use(authenticate, requirePermission("system.intercom"));

router.get(
  "/sites",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const result = await intercomService.getSites();
    res.sendSuccess(result);
  }),
);

router.get(
  "/main-stations",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const result = await intercomService.getMainStations();
    res.sendSuccess(result);
  }),
);

router.get(
  "/zones/:id/logs/latest",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const zoneId = parseInt(req.params.id, 10);
    const result = await intercomService.getZoneLogsLatest(zoneId, {
      limit: 5,
    });
    res.sendSuccess(result);
  }),
);

router.post(
  "/locations/:id/ring",
  requirePermission("system.intercom.ring"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const locationId = parseInt(req.params.id, 10);
    const result = await intercomService.ringLocation(locationId, {
      actorUserId: req.user?.id ?? null,
    });
    res.sendSuccess(result);
  }),
);

module.exports = router;
