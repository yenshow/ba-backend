const express = require("express");
const router = express.Router();
const deviceService = require("../services/devices/deviceService");
const deviceTypeService = require("../services/devices/deviceTypeService");
const deviceModelService = require("../services/devices/deviceModelService");
const devicePreviewService = require("../services/devices/devicePreviewService");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// ========== 設備類型 API ==========
// 注意：必須放在 /:id 之前，避免路由衝突

// 取得所有設備類型（公開）
router.get("/types", noCache, asyncHandler(async (req, res) => {
	const result = await deviceTypeService.getAllDeviceTypes();
	res.sendSuccess(result);
}));

// 根據代碼取得設備類型（公開）
router.get("/types/code/:code", noCache, asyncHandler(async (req, res) => {
	const { code } = req.params;
	const result = await deviceTypeService.getDeviceTypeByCode(code);
	res.sendSuccess(result);
}));

// 取得單一設備類型（公開）
router.get("/types/:id", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await deviceTypeService.getDeviceTypeById(parseInt(id));
	res.sendSuccess(result);
}));

// 建立設備類型（需要管理員權限）
router.post("/types", authenticate, requireAdmin, asyncHandler(async (req, res) => {
	const result = await deviceTypeService.createDeviceType(req.body);
	res.sendSuccess(result, 201);
}));

// 更新設備類型（需要管理員權限）
router.put("/types/:id", authenticate, requireAdmin, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await deviceTypeService.updateDeviceType(parseInt(id), req.body);
	res.sendSuccess(result);
}));

// 刪除設備類型（需要管理員權限）
router.delete("/types/:id", authenticate, requireAdmin, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await deviceTypeService.deleteDeviceType(parseInt(id));
	res.sendSuccess(result);
}));

// ========== 設備型號 API ==========
// 注意：必須放在 /:id 之前，避免路由衝突

// 取得設備型號列表（支援按類型篩選）
router.get("/models", noCache, asyncHandler(async (req, res) => {
	const { type_id, type_code } = req.query;
	const result = await deviceModelService.getAllDeviceModels({
		type_id: type_id ? parseInt(type_id) : undefined,
		type_code
	});
	res.sendSuccess(result);
}));

// 取得單一設備型號
router.get("/models/:id", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await deviceModelService.getDeviceModelById(parseInt(id));
	res.sendSuccess(result);
}));

// 建立設備型號（需要管理員權限）
router.post("/models", authenticate, requireAdmin, asyncHandler(async (req, res) => {
	const result = await deviceModelService.createDeviceModel(req.body, req.user.id);
	res.sendSuccess(result, 201);
}));

// 更新設備型號（需要管理員權限）
router.put("/models/:id", authenticate, requireAdmin, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await deviceModelService.updateDeviceModel(parseInt(id), req.body, req.user.id);
	res.sendSuccess(result);
}));

// 刪除設備型號（需要管理員權限）
router.delete("/models/:id", authenticate, requireAdmin, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await deviceModelService.deleteDeviceModel(parseInt(id));
	res.sendSuccess(result);
}));

// ========== 設備 API ==========

// 取得設備列表（支援篩選）
router.get("/", noCache, asyncHandler(async (req, res) => {
	const { type_id, type_code, status, limit, offset, orderBy, order } = req.query;
	const result = await deviceService.getDevices({
		type_id: type_id ? parseInt(type_id) : undefined,
		type_code,
		status,
		limit: limit ? parseInt(limit) : undefined,
		offset: offset ? parseInt(offset) : undefined,
		orderBy,
		order
	});
	res.sendSuccess(result);
}));

// 取得設備 MJPEG 預覽 URL（須在 GET /:id 之前）
router.get("/:id/preview-url", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await devicePreviewService.getPreviewUrl(parseInt(id));
	res.sendSuccess(result);
}));

// 取得單一設備（必須放在最後，避免與 /types 和 /models 衝突）
router.get("/:id", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await deviceService.getDeviceById(parseInt(id));
	res.sendSuccess(result);
}));

// 創建設備（需要認證和管理員權限）
router.post("/", authenticate, requireAdmin, asyncHandler(async (req, res) => {
	const result = await deviceService.createDevice(req.body, req.user.id);
	res.sendSuccess(result, 201);
}));

// 更新設備（需要認證和管理員權限）
router.put("/:id", authenticate, requireAdmin, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const result = await deviceService.updateDevice(parseInt(id), req.body, req.user.id);
	res.sendSuccess(result);
}));

// 刪除設備（需要認證和管理員權限）
router.delete("/:id", authenticate, requireAdmin, validateIntegers("id"), asyncHandler(async (req, res) => {
	const { id } = req.params;
	const userId = req.user?.id;
	const result = await deviceService.deleteDevice(parseInt(id), userId);
	res.sendSuccess(result);
}));

module.exports = router;
