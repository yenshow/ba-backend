/**
 * 車輛進出 API
 */
const express = require("express");
const router = express.Router();
const vehicleAccessService = require("../services/vehicleAccess/vehicleAccessService");
const isapiVehicleSubscribeService = require("../services/vehicleAccess/isapiVehicleSubscribeService");
const {
  authenticate,
  requirePermission,
} = require("../middleware/authMiddleware");
const { requireFeature } = require("../middleware/licenseMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

router.use(
  authenticate,
  requireFeature("vehicle_access"),
  requirePermission("system.vehicle_access"),
);

router.get(
  "/sites",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await vehicleAccessService.getSites();
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id/stats",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const { startTime, endTime, timeRange } = req.query;
    const result = await vehicleAccessService.getSiteStats(siteId, {
      startTime,
      endTime,
      timeRange,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id/logs/latest",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const result = await vehicleAccessService.getSiteLogs(siteId, {
      limit: 5,
      offset: 0,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id/logs",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const limit = req.query.limit != null ? parseInt(req.query.limit, 10) : 50;
    const offset = req.query.offset != null ? parseInt(req.query.offset, 10) : 0;
    const { startTime, endTime, timeRange, search } = req.query;
    const result = await vehicleAccessService.getSiteLogs(siteId, {
      limit,
      offset,
      startTime,
      endTime,
      timeRange,
      search,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/subscribe-status",
  noCache,
  asyncHandler(async (req, res) => {
    res.sendSuccess(isapiVehicleSubscribeService.getSubscribeStatus());
  }),
);

module.exports = router;
