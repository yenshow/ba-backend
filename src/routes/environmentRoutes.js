const express = require("express");
const router = express.Router();
const environmentService = require("../services/systems/environmentService");
const systemAlert = require("../services/alerts/systemAlertHelper");
const { authenticate } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// ========== 區域管理路由 ==========

// 取得區域列表
router.get("/zones", noCache, asyncHandler(async (req, res) => {
  const result = await environmentService.getZones();
  res.sendSuccess(result);
}));

// 取得單一區域
router.get("/zones/:id", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await environmentService.getZoneById(parseInt(id));
  res.sendSuccess(result);
}));

// 建立區域（需要認證）
router.post("/zones", authenticate, asyncHandler(async (req, res) => {
  const result = await environmentService.createZone(req.body, req.user.id);
  res.sendSuccess(result, 201);
}));

// 更新區域（需要認證）
router.put("/zones/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await environmentService.updateZone(parseInt(id), req.body, req.user.id);
  res.sendSuccess(result);
}));

// 刪除區域（需要認證）
router.delete("/zones/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await environmentService.deleteZone(parseInt(id));
  res.sendSuccess(result);
}));

// ========== 感測器讀數路由 ==========

// 取得彙總讀數（須在 /readings/:locationId 前註冊）
router.get("/readings/:locationId/aggregated", noCache, asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  const { bucket, startTime, endTime } = req.query;
  const result = await environmentService.getReadingsAggregated(locationId, {
    bucket,
    startTime: startTime || undefined,
    endTime: endTime || undefined,
  });
  res.sendSuccess(result);
}));

// 取得歷史讀數（即時由 Monitor 推送 WebSocket）
router.get("/readings/:locationId", noCache, asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  const { startTime, endTime, limit } = req.query;

  const options = {};
  if (startTime) options.startTime = startTime;
  if (endTime) options.endTime = endTime;
  if (limit) options.limit = parseInt(limit);

  const result = await environmentService.getReadings(locationId, options);
  res.sendSuccess(result);
}));

// ========== 錯誤追蹤路由 ==========

// 記錄環境地點錯誤
router.post(
  "/systems/:systemId/errors",
  noCache,
  validateIntegers("systemId"),
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;
    const { errorMessage } = req.body;

    const alertCreated = await systemAlert.recordError(
      "environment",
      parseInt(systemId),
      errorMessage || "無法讀取感測器資料"
    );

    res.sendSuccess({ alertCreated });
  })
);

// 清除環境地點錯誤
router.delete(
  "/systems/:systemId/errors",
  noCache,
  validateIntegers("systemId"),
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;

    await systemAlert.clearError("environment", parseInt(systemId));
    res.sendSuccess({ success: true });
  })
);

module.exports = router;
