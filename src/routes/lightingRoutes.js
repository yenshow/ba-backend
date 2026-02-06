const express = require("express");
const router = express.Router();
const lightingService = require("../services/systems/lightingService");
const systemAlert = require("../services/alerts/systemAlertHelper");
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

// 記錄照明地點錯誤
router.post("/systems/:systemId/errors", noCache, validateIntegers("systemId"), asyncHandler(async (req, res) => {
	const { systemId } = req.params;
	const { errorMessage } = req.body;

	const alertCreated = await systemAlert.recordError(
		"lighting",
		parseInt(systemId),
		errorMessage || "無法讀取照明設備資料"
	);

	res.sendSuccess({ alertCreated });
}));

// 清除照明地點錯誤
router.delete("/systems/:systemId/errors", noCache, validateIntegers("systemId"), asyncHandler(async (req, res) => {
	const { systemId } = req.params;

	await systemAlert.clearError("lighting", parseInt(systemId));
	res.sendSuccess({ success: true });
}));

module.exports = router;

