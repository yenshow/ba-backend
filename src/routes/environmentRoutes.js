const express = require("express");
const router = express.Router();
const environmentService = require("../services/environment/environmentService");
const {
  authenticate,
  requirePermission,
  requireEnvironmentReportFullIfScoped,
} = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// 以下路由皆需登入且具備系統權限
router.use(authenticate, requirePermission("system.environment"));

// ========== 區域管理路由 ==========

// 取得區域列表
router.get(
  "/zones",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await environmentService.getZones();
    res.sendSuccess(result);
  }),
);

// 取得單一區域
router.get(
  "/zones/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await environmentService.getZoneById(parseInt(id));
    res.sendSuccess(result);
  }),
);

// 建立區域
router.post(
  "/zones",
  requirePermission("system.environment.location.create"),
  asyncHandler(async (req, res) => {
    const result = await environmentService.createZone(req.body, req.user.id);
    res.sendSuccess(result, 201);
  }),
);

// 更新區域
router.put(
  "/zones/:id",
  requirePermission("system.environment.location.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await environmentService.updateZone(
      parseInt(id),
      req.body,
      req.user.id,
    );
    res.sendSuccess(result);
  }),
);

// 刪除區域
router.delete(
  "/zones/:id",
  requirePermission("system.environment.location.delete"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await environmentService.deleteZone(parseInt(id));
    res.sendSuccess(result);
  }),
);

// ========== 感測器讀數路由 ==========

// 取得彙總讀數（須在 /readings/:locationId 前註冊）
router.get(
  "/readings/:locationId/aggregated",
  requireEnvironmentReportFullIfScoped(),
  noCache,
  asyncHandler(async (req, res) => {
    const { locationId } = req.params;
    const { bucket, startTime, endTime } = req.query;
    const result = await environmentService.getReadingsAggregated(locationId, {
      bucket,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
    });
    res.sendSuccess(result);
  }),
);

// 取得歷史讀數（即時由 Monitor 推送 WebSocket）
router.get(
  "/readings/:locationId",
  requireEnvironmentReportFullIfScoped(),
  noCache,
  asyncHandler(async (req, res) => {
    const { locationId } = req.params;
    const { startTime, endTime, limit, order } = req.query;

    const options = {};
    if (startTime) options.startTime = startTime;
    if (endTime) options.endTime = endTime;
    if (limit) options.limit = parseInt(limit);
    if (order === "desc" || order === "asc") options.order = order;

    const result = await environmentService.getReadings(locationId, options);
    res.sendSuccess(result);
  }),
);

module.exports = router;
