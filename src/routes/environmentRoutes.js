const express = require("express");
const router = express.Router();
const environmentService = require("../services/systems/environmentService");
const { authenticate } = require("../middleware/authMiddleware");

// 禁用快取的中間件
const noCache = (req, res, next) => {
	res.set({
		"Cache-Control": "no-cache, must-revalidate",
		Pragma: "no-cache",
		Expires: "0",
	});
	next();
};

// ========== 樓層管理路由 ==========

// 取得樓層列表
router.get("/floors", noCache, async (req, res, next) => {
	try {
		const result = await environmentService.getFloors();
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 取得單一樓層
router.get("/floors/:id", noCache, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await environmentService.getFloorById(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 建立樓層（需要認證）
router.post("/floors", authenticate, async (req, res, next) => {
	try {
		const result = await environmentService.createFloor(req.body, req.user.id);
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

// 更新樓層（需要認證）
router.put("/floors/:id", authenticate, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await environmentService.updateFloor(parseInt(id), req.body, req.user.id);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 刪除樓層（需要認證）
router.delete("/floors/:id", authenticate, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await environmentService.deleteFloor(parseInt(id));
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// ========== 感測器讀數路由 ==========

// 儲存感測器讀數（公開，因為是系統自動儲存）
router.post("/readings", noCache, async (req, res, next) => {
	try {
		const result = await environmentService.saveReading(req.body);
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

// 取得歷史讀數（公開）
router.get("/readings/:locationId", noCache, async (req, res, next) => {
	try {
		const { locationId } = req.params;
		const { startTime, endTime, limit } = req.query;

		const options = {};
		if (startTime) options.startTime = startTime;
		if (endTime) options.endTime = endTime;
		if (limit) options.limit = parseInt(limit);

		const result = await environmentService.getReadings(locationId, options);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

module.exports = router;

