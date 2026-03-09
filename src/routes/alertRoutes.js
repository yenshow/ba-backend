const express = require("express");
const router = express.Router();
const alertService = require("../services/alerts/alertService");
const alertRuleService = require("../services/alerts/alertRuleService");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// 以下路由皆需登入
router.use(authenticate);

// ========== 警示 API ==========

// 取得警示列表
router.get("/", noCache, asyncHandler(async (req, res) => {
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

  res.sendSuccess(result);
}));

// 取得未解決的警示數量（支持時間範圍篩選）
router.get("/unresolved/count", noCache, asyncHandler(async (req, res) => {
  const {
    source,
    source_id,
    device_id,
    alert_type,
    severity,
    start_date,
    end_date,
  } = req.query;

  const count = await alertService.getUnresolvedAlertCount({
    source,
    source_id: source_id ? parseInt(source_id) : undefined,
    device_id: device_id ? parseInt(device_id) : undefined, // 向後兼容
    alert_type,
    severity,
    start_date, // 支持時間範圍篩選
    end_date, // 支持時間範圍篩選
  });

  res.sendSuccess({ count });
}));

// 取得警報規則（用於前端顯示狀態）
router.get("/rules", noCache, asyncHandler(async (req, res) => {
  const { source, alert_type, parameter } = req.query;

  if (!source) {
    return res.sendError("source 參數為必填", 400);
  }

  let rules;
  if (alert_type === "threshold") {
    // 獲取閾值規則（支持參數過濾）
    rules = await alertRuleService.getThresholdRules(source, parameter || null);
  } else if (alert_type) {
    // 獲取特定類型的規則
    rules = await alertRuleService.getAlertRules(source, alert_type);
  } else {
    // 如果沒有指定 alert_type，返回所有閾值規則（最常用於前端顯示）
    rules = await alertRuleService.getThresholdRules(source);
  }

  res.sendSuccess({ rules });
}));

// 取得單一警示
router.get("/:id", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const alert = await alertService.getAlertById(parseInt(id));
  res.sendSuccess({ alert });
}));

// 注意：警報由系統自動解決，不提供手動解決的端點
// 系統會在檢測到問題恢復時自動將警報標記為已解決

// 標記警示為未解決（需要管理員權限）
router.put(
  "/:id/unresolve",
  requireAdmin,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) {
      return res.sendError("未提供認證資訊", 401);
    }
    const result = await alertService.unresolveAlert(parseInt(id), userId);
    res.sendSuccess({ alert: result });
  })
);

// 忽視警示（需要管理員權限，支持多系統來源）
router.post(
  "/:deviceId/:alertType/ignore",
  requireAdmin,
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const { deviceId, alertType } = req.params;
    const { source } = req.query; // 可選的系統來源參數
    const userId = req.user?.id;
    if (!userId) {
      return res.sendError("未提供認證資訊", 401);
    }

    const count = await alertService.ignoreAlerts(
      parseInt(deviceId),
      alertType,
      userId,
      source // 如果未提供，默認為 device（向後兼容）
    );
    res.sendSuccess({ message: `已忽視 ${count} 個警示`, count });
  })
);

// 取消忽視警示（需要管理員權限，支持多系統來源）
router.post(
  "/:deviceId/:alertType/unignore",
  requireAdmin,
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const { deviceId, alertType } = req.params;
    const { source } = req.query; // 可選的系統來源參數

    const count = await alertService.unignoreAlerts(
      parseInt(deviceId),
      alertType,
      source // 如果未提供，默認為 device（向後兼容）
    );
    res.sendSuccess({ message: `已取消忽視 ${count} 個警示`, count });
  })
);

module.exports = router;
