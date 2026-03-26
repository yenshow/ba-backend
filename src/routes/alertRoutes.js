const express = require("express");
const router = express.Router();
const alertService = require("../services/alerts/alertService");
const alertRuleService = require("../services/alerts/alertRuleService");
const { authenticate, requireAdminOrOperator } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

const ALLOWED_ALERT_TYPES = ["offline", "error", "threshold"];
const ALLOWED_SEVERITIES = ["warning", "error", "critical"];
const ALLOWED_CONDITION_TYPES = ["threshold", "error_count", "bit_state"];
const ALLOWED_TARGET_TYPES = ["system", "location", "zone"];

function validateRulePayload(payload, { allowPartial = false } = {}) {
  const {
    source,
    alert_type,
    severity,
    name,
    dimension_key,
    target_type,
    target_id,
    condition_type,
    condition_config,
    enabled,
  } = payload;

  if (!allowPartial || source !== undefined) {
    if (!source || typeof source !== "string") {
      return "source 為必填且需為字串";
    }
  }

  if (!allowPartial || alert_type !== undefined) {
    if (!ALLOWED_ALERT_TYPES.includes(alert_type)) {
      return `alert_type 不合法，支援：${ALLOWED_ALERT_TYPES.join(", ")}`;
    }
  }

  if (!allowPartial || severity !== undefined) {
    if (!ALLOWED_SEVERITIES.includes(severity)) {
      return `severity 不合法，支援：${ALLOWED_SEVERITIES.join(", ")}`;
    }
  }

  if (condition_type !== undefined && condition_type !== null) {
    if (!ALLOWED_CONDITION_TYPES.includes(condition_type)) {
      return `condition_type 不合法，支援：${ALLOWED_CONDITION_TYPES.join(", ")}`;
    }
  }

  if (condition_config !== undefined && condition_config !== null) {
    if (typeof condition_config !== "object" || Array.isArray(condition_config)) {
      return "condition_config 需為物件";
    }
  }

  if (name !== undefined && name !== null && typeof name !== "string") {
    return "name 需為字串";
  }

  if (dimension_key !== undefined && dimension_key !== null && typeof dimension_key !== "string") {
    return "dimension_key 需為字串";
  }

  if (target_type !== undefined && target_type !== null) {
    if (!ALLOWED_TARGET_TYPES.includes(target_type)) {
      return `target_type 不合法，支援：${ALLOWED_TARGET_TYPES.join(", ")}`;
    }
  }

  if (target_id !== undefined && target_id !== null) {
    if (typeof target_id !== "number" || !Number.isFinite(target_id)) {
      return "target_id 需為數字";
    }
  }

  if (condition_type === "bit_state") {
    const bitKey = condition_config?.bit_key;
    if (!bitKey || typeof bitKey !== "string") {
      return "bit_state 規則需提供 condition_config.bit_key";
    }
  }

  if (enabled !== undefined && typeof enabled !== "boolean") {
    return "enabled 需為布林值";
  }

  return null;
}

// 以下路由皆需登入
router.use(authenticate);

// ========== 警示 API ==========

// 取得警示列表
router.get("/", noCache, asyncHandler(async (req, res) => {
  const {
    source,
    source_id,
    device_id, // 向後兼容
    exclude_sources,
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
    exclude_sources,
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
    exclude_sources,
    alert_type,
    severity,
    start_date,
    end_date,
  } = req.query;

  const countResult = await alertService.getUnresolvedAlertCount({
    source,
    source_id: source_id ? parseInt(source_id) : undefined,
    device_id: device_id ? parseInt(device_id) : undefined, // 向後兼容
    exclude_sources,
    alert_type,
    severity,
    start_date, // 支持時間範圍篩選
    end_date, // 支持時間範圍篩選
  });

  res.sendSuccess(countResult);
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

// 建立警報規則（需要 admin/operator 權限）
router.post(
  "/rules",
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const validationError = validateRulePayload(req.body, { allowPartial: false });
    if (validationError) {
      return res.sendError(validationError, 400);
    }

    const rule = await alertRuleService.createAlertRule(req.body);
    res.sendSuccess({ rule });
  })
);

// 更新警報規則（需要 admin/operator 權限）
router.put(
  "/rules/:id",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const validationError = validateRulePayload(req.body, { allowPartial: true });
    if (validationError) {
      return res.sendError(validationError, 400);
    }

    try {
      const rule = await alertRuleService.updateAlertRule(parseInt(id), req.body);
      res.sendSuccess({ rule });
    } catch (error) {
      if (error.message === "RULE_NOT_FOUND") {
        return res.sendError("找不到指定的規則", 404);
      }
      throw error;
    }
  })
);

// 刪除警報規則（需要 admin/operator 權限）
router.delete(
  "/rules/:id",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    try {
      const rule = await alertRuleService.deleteAlertRule(parseInt(id));
      res.sendSuccess({ rule });
    } catch (error) {
      if (error.message === "RULE_NOT_FOUND") {
        return res.sendError("找不到指定的規則", 404);
      }
      throw error;
    }
  })
);

// 取得單一警示
router.get("/:id", noCache, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const alert = await alertService.getAlertById(parseInt(id));
  res.sendSuccess({ alert });
}));

// 注意：警報由系統自動解決，不提供手動解決的端點
// 系統會在檢測到問題恢復時自動將警報標記為已解決

// 標記警示為未解決（需要 admin/operator 權限）
router.put(
  "/:id/unresolve",
  requireAdminOrOperator,
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

// 忽視警示（需要 admin/operator 權限，支持多系統來源）
router.post(
  "/:deviceId/:alertType/ignore",
  requireAdminOrOperator,
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const { deviceId, alertType } = req.params;
    const { source, dimension_key } = req.query; // 可選的系統來源/維度參數
    const userId = req.user?.id;
    if (!userId) {
      return res.sendError("未提供認證資訊", 401);
    }

    const count = await alertService.ignoreAlerts(
      parseInt(deviceId),
      alertType,
      userId,
      source, // 如果未提供，默認為 device（向後兼容）
      dimension_key || null,
    );
    res.sendSuccess({ message: `已忽視 ${count} 個警示`, count });
  })
);

// 取消忽視警示（需要 admin/operator 權限，支持多系統來源）
router.post(
  "/:deviceId/:alertType/unignore",
  requireAdminOrOperator,
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const { deviceId, alertType } = req.params;
    const { source, dimension_key } = req.query; // 可選的系統來源/維度參數

    const count = await alertService.unignoreAlerts(
      parseInt(deviceId),
      alertType,
      source, // 如果未提供，默認為 device（向後兼容）
      dimension_key || null,
    );
    res.sendSuccess({ message: `已取消忽視 ${count} 個警示`, count });
  })
);

module.exports = router;
