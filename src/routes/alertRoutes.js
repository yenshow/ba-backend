const express = require("express");
const router = express.Router();
const alertService = require("../services/alertService");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");

// ========== 警示 API ==========

// 取得警示列表（公開，但建議加上認證）
router.get("/", async (req, res, next) => {
	try {
		const {
			device_id,
			alert_type,
			severity,
			resolved,
			limit,
			offset,
			orderBy,
			order
		} = req.query;

		const result = await alertService.getAlerts({
			device_id: device_id ? parseInt(device_id) : undefined,
			alert_type,
			severity,
			resolved: resolved !== undefined ? resolved === "true" : undefined,
			limit: limit ? parseInt(limit) : undefined,
			offset: offset ? parseInt(offset) : undefined,
			orderBy,
			order
		});

		// 禁用快取，確保取得最新資料
		res.set({
			"Cache-Control": "no-cache, must-revalidate",
			"Pragma": "no-cache",
			"Expires": "0"
		});
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 取得未解決的警示數量（公開）
router.get("/unresolved/count", async (req, res, next) => {
	try {
		const { device_id, alert_type, severity } = req.query;

		const count = await alertService.getUnresolvedAlertCount({
			device_id: device_id ? parseInt(device_id) : undefined,
			alert_type,
			severity
		});

		res.json({ count });
	} catch (error) {
		next(error);
	}
});

// 取得單一警示（公開）
router.get("/:id", async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await alertService.getAlertById(parseInt(id));

		res.json({ alert: result });
	} catch (error) {
		next(error);
	}
});

// 創建警示（需要認證，管理員或操作員）
router.post("/", authenticate, async (req, res, next) => {
	try {
		const result = await alertService.createAlert(req.body);
		res.status(201).json({ alert: result });
	} catch (error) {
		next(error);
	}
});

// 標記警示為已解決（需要認證）
router.put("/:id/resolve", authenticate, async (req, res, next) => {
	try {
		const { id } = req.params;
		const userId = req.user?.id;

		if (!userId) {
			return res.status(401).json({ error: true, message: "未提供認證資訊" });
		}

		const result = await alertService.resolveAlert(parseInt(id), userId);
		res.json({ alert: result });
	} catch (error) {
		next(error);
	}
});

// 標記警示為未解決（需要認證，管理員）
router.put("/:id/unresolve", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await alertService.unresolveAlert(parseInt(id));
		res.json({ alert: result });
	} catch (error) {
		next(error);
	}
});

// 刪除警示（需要認證，管理員）
router.delete("/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const { id } = req.params;
		await alertService.deleteAlert(parseInt(id));
		res.json({ success: true, message: "警示已刪除" });
	} catch (error) {
		next(error);
	}
});

module.exports = router;

