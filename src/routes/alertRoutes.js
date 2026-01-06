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
      alert_type,
      severity,
      status,
      resolved, // 向後兼容
      ignored, // 向後兼容
      start_date,
      end_date,
      updated_after, // 增量查詢：只獲取更新時間在此之後的警報
      limit,
      offset,
      orderBy,
      order,
    } = req.query;

    const result = await alertService.getAlerts({
      source,
      source_id: source_id ? parseInt(source_id) : undefined,
      device_id: device_id ? parseInt(device_id) : undefined, // 向後兼容
      alert_type,
      severity,
      status,
      resolved: resolved !== undefined ? resolved === "true" : undefined, // 向後兼容
      ignored: ignored !== undefined ? ignored === "true" : undefined, // 向後兼容
      start_date,
      end_date,
      updated_after, // 增量查詢：只獲取更新時間在此之後的警報
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

// 取得警示歷史記錄（公開）
router.get("/:id/history", async (req, res, next) => {
  try {
    const { id } = req.params;
    const history = await alertService.getAlertHistory(parseInt(id));

    res.json({ history });
  } catch (error) {
    next(error);
  }
});

// 注意：警報由系統自動解決，不提供手動解決的端點
// 系統會在檢測到問題恢復時自動將警報標記為已解決

// 標記警示為未解決（需要認證，管理員）
router.put(
  "/:id/unresolve",
  authenticate,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const userId = getAuthenticatedUserId(req, res);
      if (!userId) return;
      const result = await alertService.unresolveAlert(parseInt(id), userId);
      res.json({ alert: result });
    } catch (error) {
      next(error);
    }
  }
);

// 忽視警示（需要管理員權限，支持多系統來源）
router.post(
  "/:deviceId/:alertType/ignore",
  authenticate,
  requireAdmin,
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

// 取消忽視警示（需要管理員權限，支持多系統來源）
router.post(
  "/:deviceId/:alertType/unignore",
  authenticate,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { deviceId, alertType } = req.params;
      const { source } = req.query; // 可選的系統來源參數

      const count = await alertService.unignoreAlerts(
        parseInt(deviceId),
        alertType,
        source // 如果未提供，默認為 device（向後兼容）
      );
      res.json({ success: true, message: `已取消忽視 ${count} 個警示`, count });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
