/**
 * 車輛進出 API
 */
const express = require("express");
const router = express.Router();
const vehicleAccessService = require("../services/vehicleAccess/vehicleAccessService");
const isapiVehicleSubscribeService = require("../services/vehicleAccess/isapiVehicleSubscribeService");
const isapiVehicleDeviceService = require("../services/vehicleAccess/isapiVehicleDeviceService");
const personLicensePlateService = require("../services/personnel/personLicensePlateService");
const {
  authenticate,
  requirePermission,
  requirePlateUpsert,
} = require("../middleware/authMiddleware");
const { requireFeature } = require("../middleware/licenseMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const {
  resolveTimeOptions,
  ENTRY_EXIT_MAX_RECORDS,
} = require("../services/entryExit/resolveTimeOptions");
const { validateIntegers, validateNumbers } = require("../middleware/validation");

router.use(
  authenticate,
  requireFeature("vehicle_access"),
  requirePermission("system.vehicle_access"),
);

router.get(
  "/sites",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const result = await vehicleAccessService.getSites();
    res.sendSuccess(result);
  }),
);

/**
 * 跨地點過車紀錄（完整報表）
 * GET /api/vehicle-access/logs
 */
router.get(
  "/logs",
  requirePermission("system.vehicle_access.report.full"),
  disableHttpCache,
  validateNumbers("siteId", "limit", "offset"),
  asyncHandler(async (req, res) => {
    const { limit, offset, siteId, startTime, endTime, timeRange, search } =
      req.query;
    const resolved = resolveTimeOptions({ startTime, endTime, timeRange });
    const result = await vehicleAccessService.getAllSiteLogs({
      limit: limit ? parseInt(limit, 10) : ENTRY_EXIT_MAX_RECORDS,
      offset: offset ? parseInt(offset, 10) : 0,
      siteId: siteId ? parseInt(siteId, 10) : undefined,
      startTime: resolved.startTime,
      endTime: resolved.endTime,
      search: search != null ? String(search).trim() : undefined,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id/stats",
  disableHttpCache,
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
  "/sites/:id/organization-groups",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const result = await vehicleAccessService.getOrganizationGroups(siteId);
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id/session-stats",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const result = await vehicleAccessService.getSiteSessionStats(siteId);
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id/presence",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const result = await vehicleAccessService.getSitePresence(siteId);
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id/presence/plates",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const result = await vehicleAccessService.getSitePresencePlates(siteId);
    res.sendSuccess(result);
  }),
);

router.post(
  "/sites/:id/reset",
  requirePermission("system.vehicle_access.statistics.reset"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const result = await vehicleAccessService.resetSiteStats(
      siteId,
      req.user?.id ?? null,
    );
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id/logs/latest",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const { since } = req.query;
    const result = await vehicleAccessService.getSiteLogs(siteId, {
      limit: 5,
      offset: 0,
      since,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id/logs",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const limit = req.query.limit != null ? parseInt(req.query.limit, 10) : 50;
    const offset = req.query.offset != null ? parseInt(req.query.offset, 10) : 0;
    const { startTime, endTime, timeRange, search, since } = req.query;
    const result = await vehicleAccessService.getSiteLogs(siteId, {
      limit,
      offset,
      startTime,
      endTime,
      timeRange,
      since,
      search,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/subscribe-status",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    res.sendSuccess(isapiVehicleSubscribeService.getSubscribeStatus());
  }),
);

/**
 * ISAPI 設備端車牌名單查詢
 * POST /api/vehicle-access/devices/:deviceId/license-plates/search
 */
router.post(
  "/devices/:deviceId/license-plates/search",
  requirePermission("system.vehicle_access.plate.manage"),
  disableHttpCache,
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    const siteId =
      req.query.siteId != null ? parseInt(req.query.siteId, 10) : undefined;
    const channelId =
      req.query.channelId != null
        ? parseInt(req.query.channelId, 10)
        : req.body?.channelId;
    const result = await isapiVehicleDeviceService.searchLicensePlates(
      deviceId,
      {
        siteId,
        channelId,
        searchResultPosition:
          req.body?.searchResultPosition ?? req.query.searchResultPosition,
        maxResults: req.body?.maxResults ?? req.query.maxResults,
      },
    );
    res.sendSuccess(result);
  }),
);

/**
 * ISAPI 設備端車牌新增／修改
 * PUT /api/vehicle-access/devices/:deviceId/license-plates
 */
router.put(
  "/devices/:deviceId/license-plates",
  requirePlateUpsert(),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    const siteId =
      req.query.siteId != null ? parseInt(req.query.siteId, 10) : undefined;
    const result = await isapiVehicleDeviceService.upsertLicensePlates(
      deviceId,
      {
        siteId,
        channelId: req.body?.channelId ?? req.query.channelId,
        plates: req.body?.plates,
      },
    );

    const bindings = [];
    for (const plate of req.body?.plates || []) {
      const bindPersonId =
        plate?.bindPersonId ?? plate?.bind_person_id ?? null;
      if (bindPersonId == null) continue;
      const bound = await personLicensePlateService.upsertPlateForPerson(
        bindPersonId,
        {
          plateNumber: plate.licensePlate || plate.id,
          listType: plate.listType,
          effectiveBegin: plate.createTime,
          effectiveEnd: plate.effectiveTime,
        },
        { markSynced: true },
      );
      bindings.push(bound);
    }

    res.sendSuccess({ ...result, bindings });
  }),
);

/**
 * ISAPI 設備端車牌刪除
 * DELETE /api/vehicle-access/devices/:deviceId/license-plates
 */
router.delete(
  "/devices/:deviceId/license-plates",
  requirePermission("system.vehicle_access.plate.delete"),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    const siteId =
      req.query.siteId != null ? parseInt(req.query.siteId, 10) : undefined;
    const result = await isapiVehicleDeviceService.deleteLicensePlates(
      deviceId,
      {
        siteId,
        channelId: req.body?.channelId ?? req.query.channelId,
        ids: req.body?.ids,
        licensePlates: req.body?.licensePlates,
      },
    );

    const unbound = [];
    for (const plate of req.body?.licensePlates || []) {
      const removed = await personLicensePlateService.deleteByPlateNormalized(plate);
      if (removed) unbound.push(removed);
    }

    res.sendSuccess({ ...result, unbound });
  }),
);

/**
 * 柵欄機控制
 * PUT /api/vehicle-access/devices/:deviceId/barrier-gate
 */
router.put(
  "/devices/:deviceId/barrier-gate",
  requirePermission("system.vehicle_access.barrier.control"),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.deviceId, 10);
    const siteId =
      req.query.siteId != null ? parseInt(req.query.siteId, 10) : undefined;
    const result = await isapiVehicleDeviceService.controlBarrierGate(
      deviceId,
      {
        siteId,
        channelId: req.body?.channelId ?? req.query.channelId,
        ctrlMode: req.body?.ctrlMode,
      },
    );
    res.sendSuccess(result);
  }),
);

module.exports = router;
