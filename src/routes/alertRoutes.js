const express = require("express");
const router = express.Router();
const alertService = require("../services/alerts/alertService");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");

/**
 * 驗證用戶認證並返回用戶 ID
 * 用於簡化路由中的重複驗證邏輯
 */
function getAuthenticatedUserId(req, res) {
	const userId = req.user?.id;
	if (!userId) {
		res.status(401).json({ error: true, message: "未提供認證資訊" });
		return null;
	}
	return userId;
}

// ========== 警示 API ==========

// 取得警示列表（公開）
router.get("/", async (req, res, next) => {
	try {
		const {
      source,
      source_id,
      device_id, // 向後兼容
      device_type_code,
			alert_type,
			severity,
      status,
      resolved, // 向後兼容
      ignored, // 向後兼容
      start_date,
      end_date,
			limit,
			offset,
			orderBy,
      order,
		} = req.query;

		const result = await alertService.getAlerts({
      source,
      source_id: source_id ? parseInt(source_id) : undefined,
      device_id: device_id ? parseInt(device_id) : undefined, // 向後兼容
      device_type_code,
			alert_type,
			severity,
      status,
      resolved: resolved !== undefined ? resolved === "true" : undefined, // 向後兼容
      ignored: ignored !== undefined ? ignored === "true" : undefined, // 向後兼容
      start_date,
      end_date,
			limit: limit ? parseInt(limit) : undefined,
			offset: offset ? parseInt(offset) : undefined,
			orderBy,
      order,
		});

		res.set({
			"Cache-Control": "no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
		});
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 取得未解決的警示數量（公開）
router.get("/unresolved/count", async (req, res, next) => {
	try {
    const { source, source_id, device_id, alert_type, severity } = req.query;

		const count = await alertService.getUnresolvedAlertCount({
      source,
      source_id: source_id ? parseInt(source_id) : undefined,
      device_id: device_id ? parseInt(device_id) : undefined, // 向後兼容
			alert_type,
      severity,
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

// 標記警示為已解決（需要認證，支持多系統來源）
router.put(
  "/:deviceId/:alertType/resolve",
  authenticate,
  async (req, res, next) => {
	try {
      const { deviceId, alertType } = req.params;
      const { source } = req.query; // 可選的系統來源參數
		const userId = getAuthenticatedUserId(req, res);
		if (!userId) return;

      const count = await alertService.resolveAlert(
        parseInt(deviceId),
        alertType,
        userId,
        source // 如果未提供，默認為 device（向後兼容）
      );
      res.json({ success: true, message: `已解決 ${count} 個警示`, count });
	} catch (error) {
		next(error);
	}
  }
);

// 標記警示為未解決（需要認證，管理員）
router.put(
  "/:id/unresolve",
  authenticate,
  requireAdmin,
  async (req, res, next) => {
	try {
		const { id } = req.params;
		const result = await alertService.unresolveAlert(parseInt(id));
		res.json({ alert: result });
	} catch (error) {
		next(error);
	}
  }
);

// 忽視警示（需要認證，支持多系統來源）
router.post(
  "/:deviceId/:alertType/ignore",
  authenticate,
  async (req, res, next) => {
	try {
      const { deviceId, alertType } = req.params;
      const { source } = req.query; // 可選的系統來源參數
      const userId = getAuthenticatedUserId(req, res);
      if (!userId) return;

      const count = await alertService.ignoreAlerts(
        parseInt(deviceId),
        alertType,
        userId,
        source // 如果未提供，默認為 device（向後兼容）
      );
      res.json({ success: true, message: `已忽視 ${count} 個警示`, count });
	} catch (error) {
		next(error);
	}
  }
);

module.exports = router;
