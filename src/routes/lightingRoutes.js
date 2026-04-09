const express = require("express");
const router = express.Router();
const lightingService = require("../services/systems/lightingService");
const { authenticate } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// ========== 區域管理路由 ==========

// 取得區域列表
router.get("/zones", noCache, authenticate, asyncHandler(async (req, res) => {
	const result = await lightingService.getZones();
	res.sendSuccess(result);
}));

// 取得單一區域
router.get("/zones/:id", noCache, authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
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

module.exports = router;

