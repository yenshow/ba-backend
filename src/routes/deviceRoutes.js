const express = require("express");
const router = express.Router();
const deviceService = require("../services/deviceService");
const deviceTypeService = require("../services/deviceTypeService");
const deviceModelService = require("../services/deviceModelService");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");

// ========== 設備類型 API ==========
// 注意：必須放在 /:id 之前，避免路由衝突

// 取得所有設備類型（公開）
router.get("/types", async (req, res, next) => {
	try {
		const result = await deviceTypeService.getAllDeviceTypes();
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 根據代碼取得設備類型（公開）⭐ 新增（必須在 /types/:id 之前）
router.get("/types/code/:code", async (req, res, next) => {
	try {
		const { code } = req.params;
		const result = await deviceTypeService.getDeviceTypeByCode(code);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 取得單一設備類型（公開）
router.get("/types/:id", async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await deviceTypeService.getDeviceTypeById(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 建立設備類型（需要管理員權限）
router.post("/types", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const result = await deviceTypeService.createDeviceType(req.body);
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

// 更新設備類型（需要管理員權限）
router.put("/types/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await deviceTypeService.updateDeviceType(parseInt(id), req.body);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 刪除設備類型（需要管理員權限）
router.delete("/types/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await deviceTypeService.deleteDeviceType(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// ========== 設備型號 API ==========
// 注意：必須放在 /:id 之前，避免路由衝突

// 取得設備型號列表（支援按類型篩選）
router.get("/models", async (req, res, next) => {
	try {
		const { type_id, type_code } = req.query;
		const result = await deviceModelService.getAllDeviceModels({
			type_id: type_id ? parseInt(type_id) : undefined,
			type_code
		});
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 取得單一設備型號
router.get("/models/:id", async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await deviceModelService.getDeviceModelById(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 建立設備型號（需要管理員權限）
router.post("/models", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const result = await deviceModelService.createDeviceModel(req.body, req.user.id);
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

// 更新設備型號（需要管理員權限）
router.put("/models/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await deviceModelService.updateDeviceModel(parseInt(id), req.body, req.user.id);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 刪除設備型號（需要管理員權限）
router.delete("/models/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await deviceModelService.deleteDeviceModel(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// ========== 設備 API ==========

// 取得設備列表（支援篩選）
router.get("/", async (req, res, next) => {
	try {
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
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 取得單一設備（必須放在最後，避免與 /types 和 /models 衝突）
router.get("/:id", async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await deviceService.getDeviceById(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 創建設備（需要認證和管理員權限）
router.post("/", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const result = await deviceService.createDevice(req.body, req.user.id);
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

// 更新設備（需要認證和管理員權限）
router.put("/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await deviceService.updateDevice(parseInt(id), req.body, req.user.id);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 刪除設備（需要認證和管理員權限）
router.delete("/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await deviceService.deleteDevice(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

module.exports = router;
