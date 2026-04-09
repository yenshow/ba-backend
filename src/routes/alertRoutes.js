const express = require("express");
const router = express.Router();
const alertService = require("../services/alerts/alertService");
const alertRuleService = require("../services/alerts/alertRuleService");
const alertLinkageService = require("../services/alerts/alertLinkageService");
const {
  authenticate,
  requireAdminOrOperator,
} = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

const ALLOWED_ALERT_TYPES = ["offline", "error", "threshold", "di", "do"];
const ALLOWED_SEVERITIES = ["warning", "error", "critical"];
const ALLOWED_RULE_ALERT_TYPES = ["offline", "threshold", "di", "do"];
const ALLOWED_RULE_SEVERITIES = ["warning", "critical"];
const ALLOWED_CONDITION_TYPES = ["threshold", "error_count", "bit_state"];
const ALLOWED_TARGET_TYPES = ["system", "location", "zone"];
const ALLOWED_MESSAGE_TEMPLATE_KEYS = [
  "rule.threshold.v1",
  "rule.offline.v1",
  "rule.di.v1",
  "rule.do.v1",
  "custom",
];

/** 閾值條件運算子（不支援 = / ==） */
const ALLOWED_THRESHOLD_OPERATORS = [">", ">=", "<", "<="];

const ALLOWED_LINKAGE_SEVERITIES = ["warning", "error", "critical"];

function validateLinkagePayload(payload, { allowPartial = false } = {}) {
  const p = payload || {};

  if (!allowPartial || p.enabled !== undefined) {
    if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
      return "enabled 需為布林值";
    }
  }

  if (!allowPartial || p.trigger_source !== undefined) {
    if (!p.trigger_source || typeof p.trigger_source !== "string") {
      return "trigger_source 為必填且需為字串";
    }
  }

  if (!allowPartial || p.trigger_alert_type !== undefined) {
    if (!p.trigger_alert_type || typeof p.trigger_alert_type !== "string") {
      return "trigger_alert_type 為必填且需為字串";
    }
    if (!ALLOWED_ALERT_TYPES.includes(p.trigger_alert_type)) {
      return `trigger_alert_type 不合法，支援：${ALLOWED_ALERT_TYPES.join(", ")}`;
    }
  }

  if (!allowPartial || p.trigger_dimension_key !== undefined) {
    if (
      p.trigger_dimension_key !== undefined &&
      p.trigger_dimension_key !== null &&
      typeof p.trigger_dimension_key !== "string"
    ) {
      return "trigger_dimension_key 需為字串或 null";
    }
  }

  if (!allowPartial || p.trigger_severity_min !== undefined) {
    const v = p.trigger_severity_min ?? "warning";
    if (typeof v !== "string" || !ALLOWED_LINKAGE_SEVERITIES.includes(v)) {
      return `trigger_severity_min 不合法，支援：${ALLOWED_LINKAGE_SEVERITIES.join(", ")}`;
    }
  }

  if (!allowPartial || p.do_device_id !== undefined) {
    if (p.do_device_id === null || p.do_device_id === undefined) {
      return "do_device_id 為必填";
    }
    if (!Number.isInteger(p.do_device_id) || p.do_device_id <= 0) {
      return "do_device_id 需為正整數";
    }
  }

  if (!allowPartial || p.do_address !== undefined) {
    if (p.do_address === null || p.do_address === undefined) {
      return "do_address 為必填";
    }
    if (!Number.isInteger(p.do_address) || p.do_address < 0) {
      return "do_address 需為非負整數";
    }
  }

  if (!allowPartial || p.do_value !== undefined) {
    if (p.do_value !== undefined && typeof p.do_value !== "boolean") {
      return "do_value 需為布林值";
    }
  }

  if (!allowPartial || p.auto_off_seconds !== undefined) {
    if (p.auto_off_seconds === null || p.auto_off_seconds === undefined) {
      // ok
    } else if (!Number.isInteger(p.auto_off_seconds) || p.auto_off_seconds <= 0) {
      return "auto_off_seconds 需為正整數或 null";
    }
  }

  if (!allowPartial || p.name !== undefined) {
    if (p.name !== undefined && p.name !== null && typeof p.name !== "string") {
      return "name 需為字串或 null";
    }
  }

  return null;
}

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
    // 規則端禁用 error（error 保留給 incident / 系統錯誤）
    if (
      alert_type !== null &&
      alert_type !== undefined &&
      !ALLOWED_RULE_ALERT_TYPES.includes(alert_type)
    ) {
      return `規則不允許的 alert_type：${alert_type}（規則僅允許：${ALLOWED_RULE_ALERT_TYPES.join(", ")}）`;
    }
  }

  if (!allowPartial || severity !== undefined) {
    if (!ALLOWED_SEVERITIES.includes(severity)) {
      return `severity 不合法，支援：${ALLOWED_SEVERITIES.join(", ")}`;
    }
    // 規則端 severity 收斂為 warning/critical
    if (
      severity !== null &&
      severity !== undefined &&
      !ALLOWED_RULE_SEVERITIES.includes(severity)
    ) {
      return `規則不允許的 severity：${severity}（規則僅允許：${ALLOWED_RULE_SEVERITIES.join(", ")}）`;
    }
  }

  if (condition_type !== undefined && condition_type !== null) {
    if (!ALLOWED_CONDITION_TYPES.includes(condition_type)) {
      return `condition_type 不合法，支援：${ALLOWED_CONDITION_TYPES.join(", ")}`;
    }
  }

  if (condition_config !== undefined && condition_config !== null) {
    if (
      typeof condition_config !== "object" ||
      Array.isArray(condition_config)
    ) {
      return "condition_config 需為物件";
    }
  }

  if (name !== undefined && name !== null && typeof name !== "string") {
    return "name 需為字串";
  }

  if (
    dimension_key !== undefined &&
    dimension_key !== null &&
    typeof dimension_key !== "string"
  ) {
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

  if (
    payload.message_template_key !== undefined &&
    payload.message_template_key !== null
  ) {
    if (typeof payload.message_template_key !== "string") {
      return "message_template_key 需為字串";
    }
    if (!ALLOWED_MESSAGE_TEMPLATE_KEYS.includes(payload.message_template_key)) {
      return `message_template_key 不合法，支援：${ALLOWED_MESSAGE_TEMPLATE_KEYS.join(", ")}`;
    }
  }

  if (
    payload.message_template_custom !== undefined &&
    typeof payload.message_template_custom !== "boolean"
  ) {
    return "message_template_custom 需為布林值";
  }

  if (
    payload.message_template !== undefined &&
    payload.message_template !== null &&
    typeof payload.message_template !== "string"
  ) {
    return "message_template 需為字串";
  }

  const condCfg = payload.condition_config;
  const allowedOpHint = `僅支援 ${ALLOWED_THRESHOLD_OPERATORS.join("、")}（不支援 = / ==）`;
  const opStr =
    condCfg?.operator === undefined || condCfg?.operator === null || condCfg?.operator === ""
      ? ""
      : String(condCfg.operator);
  const opOk = opStr !== "" && ALLOWED_THRESHOLD_OPERATORS.includes(opStr);
  if (opStr !== "" && !opOk) {
    return `threshold 的 operator 不合法，${allowedOpHint}`;
  }
  if (!allowPartial && condition_type === "threshold" && !opOk) {
    return `threshold 規則需提供 operator，且 ${allowedOpHint}`;
  }

  return null;
}

function validateRulePreviewPayload(payload) {
  if (!payload.source || typeof payload.source !== "string") {
    return "source 為必填且需為字串";
  }
  if (
    !payload.alert_type ||
    !ALLOWED_RULE_ALERT_TYPES.includes(payload.alert_type)
  ) {
    return `alert_type 為必填且需為規則允許值：${ALLOWED_RULE_ALERT_TYPES.join(", ")}`;
  }
  if (
    payload.condition_type != null &&
    !ALLOWED_CONDITION_TYPES.includes(payload.condition_type)
  ) {
    return `condition_type 不合法，支援：${ALLOWED_CONDITION_TYPES.join(", ")}`;
  }
  if (
    payload.message_template_key != null &&
    payload.message_template_key !== ""
  ) {
    if (typeof payload.message_template_key !== "string") {
      return "message_template_key 需為字串";
    }
    if (!ALLOWED_MESSAGE_TEMPLATE_KEYS.includes(payload.message_template_key)) {
      return `message_template_key 不合法，支援：${ALLOWED_MESSAGE_TEMPLATE_KEYS.join(", ")}`;
    }
  }
  return null;
}

// 以下路由皆需登入
router.use(authenticate);

// ========== 警示 API ==========

// 取得警示列表
router.get(
  "/",
  noCache,
  asyncHandler(async (req, res) => {
    const {
      source,
      source_id,
      exclude_sources,
      alert_type,
      severity,
      status,
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
      exclude_sources,
      alert_type,
      severity,
      status,
      start_date,
      end_date,
      updated_after, // 增量查詢：只獲取更新時間在此之後的警報
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
      orderBy,
      order,
    });

    res.sendSuccess(result);
  }),
);

// 取得未解決的警示數量（支持時間範圍篩選）
router.get(
  "/unresolved/count",
  noCache,
  asyncHandler(async (req, res) => {
    const {
      source,
      source_id,
      exclude_sources,
      alert_type,
      severity,
      start_date,
      end_date,
    } = req.query;

    const countResult = await alertService.getUnresolvedAlertCount({
      source,
      source_id: source_id ? parseInt(source_id) : undefined,
      exclude_sources,
      alert_type,
      severity,
      start_date,
      end_date,
    });

    res.sendSuccess(countResult);
  }),
);

// 取得警報規則（用於前端顯示狀態）
router.get(
  "/rules",
  noCache,
  asyncHandler(async (req, res) => {
    const { source, alert_type, parameter } = req.query;

    if (!source) {
      return res.sendError("source 參數為必填", 400);
    }

    let rules;
    if (alert_type === "threshold") {
      // 獲取閾值規則（支持參數過濾）
      rules = await alertRuleService.getThresholdRules(
        source,
        parameter || null,
      );
    } else if (alert_type) {
      // 獲取特定類型的規則
      rules = await alertRuleService.getAlertRules(source, alert_type);
    } else {
      // 不指定 alert_type：回傳該 source 的所有啟用規則（避免前端 source x type 多次請求再 merge）
      rules = await alertRuleService.getAllRulesForSource(source);
    }

    res.sendSuccess({ rules });
  }),
);

// 規則訊息預覽（canonical 模板 + 變數；不寫入 DB）
router.post(
  "/rules/preview-message",
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const validationError = validateRulePreviewPayload(req.body);
    if (validationError) {
      return res.sendError(validationError, 400);
    }
    const preview = await alertRuleService.previewRuleMessage(req.body);
    res.sendSuccess(preview);
  }),
);

// ========== 警報連動（DI 觸發後 DO 輸出等） ==========

// 連動規則列表（MVP-2）
router.get(
  "/linkages",
  requireAdminOrOperator,
  noCache,
  asyncHandler(async (req, res) => {
    const linkages = await alertLinkageService.listLinkages();
    res.sendSuccess({ linkages });
  }),
);

// 建立連動規則（MVP-2）
router.post(
  "/linkages",
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const validationError = validateLinkagePayload(req.body, {
      allowPartial: false,
    });
    if (validationError) return res.sendError(validationError, 400);

    const userId = req.user?.id ?? null;
    const linkage = await alertLinkageService.createLinkage(req.body, userId);
    res.sendSuccess({ linkage });
  }),
);

// 更新連動規則（MVP-2）
router.put(
  "/linkages/:id",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const validationError = validateLinkagePayload(req.body, {
      allowPartial: true,
    });
    if (validationError) return res.sendError(validationError, 400);

    const userId = req.user?.id ?? null;
    const linkage = await alertLinkageService.updateLinkage(
      Number(req.params.id),
      req.body,
      userId,
    );
    res.sendSuccess({ linkage });
  }),
);

// 刪除連動規則（MVP-2）
router.delete(
  "/linkages/:id",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const linkage = await alertLinkageService.deleteLinkage(Number(req.params.id));
    res.sendSuccess({ linkage });
  }),
);

// 手動強制關閉 DO（manual off）
router.post(
  "/do-outputs/manual-off",
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { do_device_id, do_address, reason, expires_at, linkage_id } = req.body || {};
    if (!Number.isInteger(do_device_id) || do_device_id <= 0) {
      return res.sendError("do_device_id 需為正整數", 400);
    }
    if (!Number.isInteger(do_address) || do_address < 0) {
      return res.sendError("do_address 需為非負整數", 400);
    }

    const userId = req.user?.id ?? null;
    const result = await alertLinkageService.manualOffDoOutput(
      { linkage_id, do_device_id, do_address, reason, expires_at },
      userId,
    );
    res.sendSuccess(result);
  }),
);

// 解除手動覆寫（恢復自動連動）
router.post(
  "/do-outputs/release-manual-off",
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { do_device_id, do_address } = req.body || {};
    if (!Number.isInteger(do_device_id) || do_device_id <= 0) {
      return res.sendError("do_device_id 需為正整數", 400);
    }
    if (!Number.isInteger(do_address) || do_address < 0) {
      return res.sendError("do_address 需為非負整數", 400);
    }
    const result = await alertLinkageService.releaseManualOffOverride({
      do_device_id,
      do_address,
    });
    res.sendSuccess(result);
  }),
);

// 建立警報規則（需要 admin/operator 權限）
router.post(
  "/rules",
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const validationError = validateRulePayload(req.body, {
      allowPartial: false,
    });
    if (validationError) {
      return res.sendError(validationError, 400);
    }

    const rule = await alertRuleService.createAlertRule(req.body);
    res.sendSuccess({ rule });
  }),
);

// 更新警報規則（需要 admin/operator 權限）
router.put(
  "/rules/:id",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const validationError = validateRulePayload(req.body, {
      allowPartial: true,
    });
    if (validationError) {
      return res.sendError(validationError, 400);
    }

    try {
      const rule = await alertRuleService.updateAlertRule(
        parseInt(id),
        req.body,
      );
      res.sendSuccess({ rule });
    } catch (error) {
      if (error.message === "RULE_NOT_FOUND") {
        return res.sendError("找不到指定的規則", 404);
      }
      throw error;
    }
  }),
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
  }),
);

// 取得單一警示
router.get(
  "/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const alert = await alertService.getAlertById(parseInt(id));
    res.sendSuccess({ alert });
  }),
);

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
  }),
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
  }),
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
  }),
);

module.exports = router;
