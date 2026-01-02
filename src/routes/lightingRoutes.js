const express = require("express");
const router = express.Router();
const lightingService = require("../services/systems/lightingService");
const { authenticate } = require("../middleware/authMiddleware");

// 禁用快取的中間件
const noCache = (req, res, next) => {
	res.set({
		"Cache-Control": "no-cache, must-revalidate",
		"Pragma": "no-cache",
		"Expires": "0"
	});
	next();
};

// ========== 樓層管理路由 ==========

// 取得樓層列表
router.get("/floors", noCache, async (req, res, next) => {
	try {
		const result = await lightingService.getFloors();
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 取得單一樓層
router.get("/floors/:id", noCache, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await lightingService.getFloorById(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 建立樓層（需要認證）
router.post("/floors", authenticate, async (req, res, next) => {
	try {
		const result = await lightingService.createFloor(req.body, req.user.id);
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

// 更新樓層（需要認證）
router.put("/floors/:id", authenticate, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await lightingService.updateFloor(parseInt(id), req.body, req.user.id);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 刪除樓層（需要認證）
router.delete("/floors/:id", authenticate, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await lightingService.deleteFloor(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// ========== 錯誤追蹤路由 ==========

// 記錄照明區域錯誤（公開，因為是系統自動記錄）
router.post("/areas/:areaId/errors", noCache, async (req, res, next) => {
	try {
		const { areaId } = req.params;
		const { errorMessage } = req.body;
		const systemAlert = require("../services/alerts/systemAlertHelper");
		
		const alertCreated = await systemAlert.recordError(
			"lighting",
			parseInt(areaId),
			errorMessage || "無法讀取照明設備資料"
		);
		
		res.json({ success: true, alertCreated });
	} catch (error) {
		next(error);
	}
});

// 清除照明區域錯誤（公開，因為是系統自動清除）
router.delete("/areas/:areaId/errors", noCache, async (req, res, next) => {
	try {
		const { areaId } = req.params;
		const systemAlert = require("../services/alerts/systemAlertHelper");
		
		await systemAlert.clearError("lighting", parseInt(areaId));
		res.json({ success: true });
	} catch (error) {
		next(error);
	}
});

module.exports = router;

