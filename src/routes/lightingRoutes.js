const express = require("express");
const router = express.Router();
const lightingService = require("../services/lightingService");
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

module.exports = router;

