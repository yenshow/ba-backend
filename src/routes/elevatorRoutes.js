/**
 * 電梯系統路由
 */
const express = require("express");
const router = express.Router();
const elevatorService = require("../services/elevator/elevatorService");
const { MAX_LOG_RECORDS } = elevatorService;
const elevatorFloorAccessService = require("../services/elevator/elevatorFloorAccessService");
const elevatorFloorSyncJobService = require("../services/elevator/elevatorFloorSyncJobService");
const {
  authenticate,
  requirePermission,
} = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const {
  resolveTimeOptions,
} = require("../services/entryExit/resolveTimeOptions");
const {
  validateIntegers,
  validateNumbers,
} = require("../middleware/validation");

router.use(authenticate, requirePermission("system.elevator"));

router.get(
  "/sites",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const result = await elevatorService.getSites();
    res.sendSuccess(result);
  }),
);

router.get(
  "/sites/:id",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const [locationResult, logsResult] = await Promise.all([
      elevatorService.getElevatorLocationById(siteId),
      elevatorService.getSiteLogs(siteId, { limit: 5, offset: 0 }),
    ]);
    res.sendSuccess({
      ...locationResult,
      latestLogs: logsResult.logs,
    });
  }),
);

router.get(
  "/sites/:id/live",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const siteId = parseInt(req.params.id, 10);
    const live = await elevatorService.getSiteLiveState(siteId);
    res.sendSuccess({ live });
  }),
);

router.get(
  "/logs",
  requirePermission("system.elevator.report.full"),
  disableHttpCache,
  validateNumbers("siteId", "limit", "offset"),
  asyncHandler(async (req, res) => {
    const { limit, offset, siteId, startTime, endTime, timeRange, search } =
      req.query;
    const resolved = resolveTimeOptions({ startTime, endTime, timeRange });
    const result = await elevatorService.getAllSiteLogs({
      limit: limit ? parseInt(limit, 10) : MAX_LOG_RECORDS,
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
  "/locations/:id/floor-access",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const result = await elevatorFloorAccessService.getFloorAccess(
      parseInt(req.params.id, 10),
    );
    res.sendSuccess(result);
  }),
);

router.put(
  "/locations/:id/floor-access",
  requirePermission("system.elevator.floor.manage"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const result = await elevatorFloorAccessService.replaceFloorAccess(
      parseInt(req.params.id, 10),
      req.body?.assignments,
    );
    res.sendSuccess(result);
  }),
);

router.get(
  "/locations/:id/sync-candidates",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const result = await elevatorFloorSyncJobService.getSyncCandidatesForLocation(
      parseInt(req.params.id, 10),
    );
    res.sendSuccess(result);
  }),
);

router.post(
  "/sync-location/:locationId/job",
  requirePermission("system.elevator.floor.manage"),
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const result = await elevatorFloorSyncJobService.startLocationSyncJob(
      parseInt(req.params.locationId, 10),
      req.user?.id,
    );
    res.sendSuccess(result, 202);
  }),
);

router.get(
  "/sync-location/jobs/:jobId",
  requirePermission("system.elevator.floor.manage"),
  asyncHandler(async (req, res) => {
    const result = await elevatorFloorSyncJobService.getJob(req.params.jobId);
    res.sendSuccess(result);
  }),
);

module.exports = router;
