const express = require("express");
const router = express.Router();
const environmentService = require("../services/systems/environmentService");
const { authenticate } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// ========== 樓層管理路由 ==========

// 取得樓層列表
router.get("/floors", noCache, asyncHandler(async (req, res) => {
  const result = await environmentService.getFloors();
  res.sendSuccess(result);
}));

// 取得單一樓層
router.get("/floors/:id", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await environmentService.getFloorById(parseInt(id));
  res.sendSuccess(result);
}));

// 建立樓層（需要認證）
router.post("/floors", authenticate, asyncHandler(async (req, res) => {
  const result = await environmentService.createFloor(req.body, req.user.id);
  res.sendSuccess(result, 201);
}));

// 更新樓層（需要認證）
router.put("/floors/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await environmentService.updateFloor(parseInt(id), req.body, req.user.id);
  res.sendSuccess(result);
}));

// 刪除樓層（需要認證）
router.delete("/floors/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await environmentService.deleteFloor(parseInt(id));
  res.sendSuccess(result);
}));

// ========== 感測器讀數路由 ==========

// 儲存感測器讀數（公開，因為是系統自動儲存）
router.post("/readings", noCache, asyncHandler(async (req, res) => {
  const result = await environmentService.saveReading(req.body);
  res.sendSuccess(result, 201);
}));

// 取得歷史讀數（公開）
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
// 注意：這裡的 locationId 實際上是 systemId (location_systems.id)
// 為了向後兼容，保留 locationId 參數名，但實際接收的是 systemId

// 記錄環境位置錯誤（公開，因為是系統自動記錄）
// 注意：這裡的 locationId 實際上是 systemId (location_systems.id)
router.post(
  "/locations/:locationId/errors",
  noCache,
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const { locationId } = req.params; // 實際上是 systemId (location_systems.id)
    const { errorMessage } = req.body;
    const systemAlert = require("../services/alerts/systemAlertHelper");

    const alertCreated = await systemAlert.recordError(
      "environment",
      parseInt(locationId),
      errorMessage || "無法讀取感測器資料"
    );

    res.sendSuccess({ alertCreated });
  })
);

// 清除環境位置錯誤（公開，因為是系統自動清除）
// 注意：這裡的 locationId 實際上是 systemId (location_systems.id)
router.delete(
  "/locations/:locationId/errors",
  noCache,
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const { locationId } = req.params; // 實際上是 systemId (location_systems.id)
    const systemAlert = require("../services/alerts/systemAlertHelper");

    await systemAlert.clearError("environment", parseInt(locationId));
    res.sendSuccess({ success: true });
  })
);

module.exports = router;
