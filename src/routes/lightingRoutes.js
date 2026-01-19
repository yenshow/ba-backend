const express = require("express");
const router = express.Router();
const lightingService = require("../services/systems/lightingService");
const { authenticate } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// ========== 區域管理路由 ==========

// 取得區域列表
router.get("/zones", noCache, asyncHandler(async (req, res) => {
	const result = await lightingService.getZones();
	res.sendSuccess(result);
}));

// 取得單一區域
router.get("/zones/:id", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await lightingService.getZoneById(parseInt(id));
	res.sendSuccess(result);
}));

// 建立區域（需要認證）
router.post("/zones", authenticate, asyncHandler(async (req, res) => {
	const result = await lightingService.createZone(req.body, req.user.id);
	res.sendSuccess(result, 201);
}));

// 更新區域（需要認證）
router.put("/zones/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await lightingService.updateZone(parseInt(id), req.body, req.user.id);
	res.sendSuccess(result);
}));

// 刪除區域（需要認證）
router.delete("/zones/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await lightingService.deleteZone(parseInt(id));
	res.sendSuccess(result);
}));

// ========== 錯誤追蹤路由 ==========
// 注意：這裡的 areaId 實際上是 systemId (location_systems.id)
// 為了向後兼容，保留 areaId 參數名，但實際接收的是 systemId

// 記錄照明區域錯誤（公開，因為是系統自動記錄）
router.post("/areas/:areaId/errors", noCache, validateIntegers("areaId"), asyncHandler(async (req, res) => {
	const { areaId } = req.params; // 實際上是 systemId (location_systems.id)
	const { errorMessage } = req.body;
	const systemAlert = require("../services/alerts/systemAlertHelper");
	
	const alertCreated = await systemAlert.recordError(
		"lighting",
		parseInt(areaId),
		errorMessage || "無法讀取照明設備資料"
	);
	
	res.sendSuccess({ alertCreated });
}));

// 清除照明區域錯誤（公開，因為是系統自動清除）
router.delete("/areas/:areaId/errors", noCache, validateIntegers("areaId"), asyncHandler(async (req, res) => {
	const { areaId } = req.params; // 實際上是 systemId (location_systems.id)
	const systemAlert = require("../services/alerts/systemAlertHelper");
	
	await systemAlert.clearError("lighting", parseInt(areaId));
	res.sendSuccess({ success: true });
}));

module.exports = router;

