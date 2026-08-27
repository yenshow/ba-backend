const express = require("express");
const router = express.Router();
const alertService = require("../services/alerts/alertService");
const alertIgnoreService = require("../services/alerts/alertIgnoreService");
const alertRuleService = require("../services/alerts/alertRuleService");
const alertLinkageService = require("../services/alerts/alertLinkageService");
const alertCameraLinkageService = require("../services/alerts/alertCameraLinkageService");
const alertAccessDoorLinkageService = require("../services/alerts/alertAccessDoorLinkageService");
const {
  MAX_DEVICE_IDS: ACCESS_DOOR_LINKAGE_MAX_DEVICE_IDS,
} = alertAccessDoorLinkageService;
const alertSipRingLinkageService = require("../services/alerts/alertSipRingLinkageService");
const {
  MAX_DEVICE_IDS: SIP_RING_LINKAGE_MAX_DEVICE_IDS,
} = alertSipRingLinkageService;
const alertElevatorCallLinkageService = require("../services/alerts/alertElevatorCallLinkageService");
const {
  MAX_LOCATION_IDS: ELEVATOR_CALL_LINKAGE_MAX_LOCATION_IDS,
} = alertElevatorCallLinkageService;
const alertEmailSubscriptionService = require("../services/alerts/alertEmailSubscriptionService");
const db = require("../database/db");
const { sendSmtpMailAndClose } = require("../services/notifications/mailer");
const {
  authenticate,
  requirePermission,
  requireAlertExportIfBulk,
} = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrors");
const {
  isValidAlertThresholdParameterKey,
  listAlertThresholdParameterKeys,
} = require("../constants/environmentParameterCatalog");

const licenseService = require("../services/license/licenseService");

const ALLOWED_ALERT_TYPES = ["offline", "error", "threshold", "di", "do"];
const ALLOWED_SEVERITIES = ["warning", "error", "critical"];
const ALLOWED_RULE_ALERT_TYPES = ["offline", "threshold", "di", "do"];
const ALLOWED_RULE_SEVERITIES = ["warning", "error", "critical"];
const ALLOWED_CONDITION_TYPES = [
  "threshold",
  "error_count",
  "bit_state",
  "energy_contract_stage",
  "energy_meter_stale",
  "energy_reading_jump",
];
const ALLOWED_TARGET_TYPES = ["system", "location", "zone"];
const {
  ALLOWED_MESSAGE_TEMPLATE_KEYS,
} = require("../services/alerts/alertCopy");

/** 閾值條件運算子（不支援 = / ==） */
const ALLOWED_THRESHOLD_OPERATORS = [">", ">=", "<", "<="];

const filterLinkageByLicense = async (linkage, featureKey) => {
  if (!linkage) return null;
  return (await licenseService.isRuntimeFeatureLicensed(featureKey)) ? linkage : null;
};

const assertLinkageLicensedForUpsert = async (linkage, featureKey) => {
  if (!linkage || linkage.enabled !== true) return;
  const licensed = await licenseService.isRuntimeFeatureLicensed(featureKey);
  if (!licensed) {
    throwApiError(C.FEATURE_NOT_LICENSED, `未授權功能：${featureKey}`, {
      details: { feature: featureKey },
    });
  }
};

async function getFilteredIntegrationsForRule(ruleId) {
  const [doLinkage, cameraRaw, accessRaw, sipRaw, elevatorRaw, emailSubscription] =
    await Promise.all([
      alertLinkageService.getSingleLinkageByRuleId(ruleId),
      alertCameraLinkageService.getByRuleId(ruleId),
      alertAccessDoorLinkageService.getByRuleId(ruleId),
      alertSipRingLinkageService.getByRuleId(ruleId),
      alertElevatorCallLinkageService.getByRuleId(ruleId),
      alertEmailSubscriptionService.getByRuleId(ruleId),
    ]);

  const [cameraLinkage, accessDoorLinkage, sipRingLinkage, elevatorCallLinkage] =
    await Promise.all([
      filterLinkageByLicense(cameraRaw, "surveillance"),
      filterLinkageByLicense(accessRaw, "people_counting"),
      filterLinkageByLicense(sipRaw, "access_security"),
      filterLinkageByLicense(elevatorRaw, "elevator"),
    ]);

  return {
    doLinkage,
    cameraLinkage,
    accessDoorLinkage,
    sipRingLinkage,
    elevatorCallLinkage,
    emailSubscription,
  };
}

function validateRuleIntegrationsPayload(body) {
  const b = body || {};
  if (Object.prototype.hasOwnProperty.call(b, "doLinkage") && b.doLinkage) {
    const p = b.doLinkage || {};
    if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
      return "doLinkage.enabled 需為布林值";
    }
    if (
      p.do_device_id == null ||
      !Number.isInteger(Number(p.do_device_id)) ||
      Number(p.do_device_id) <= 0
    ) {
      return "doLinkage.do_device_id 為必填且需為正整數";
    }
    if (
      p.do_address == null ||
      !Number.isInteger(Number(p.do_address)) ||
      Number(p.do_address) < 0
    ) {
      return "doLinkage.do_address 為必填且需為非負整數";
    }
    const v = String(p.do_output_value || "")
      .trim()
      .toLowerCase();
    if (v !== "on" && v !== "off") {
      return "doLinkage.do_output_value 僅允許 on/off";
    }
    if (p.auto_off_seconds != null) {
      if (
        !Number.isInteger(Number(p.auto_off_seconds)) ||
        Number(p.auto_off_seconds) <= 0
      ) {
        return "doLinkage.auto_off_seconds 需為正整數或 null";
      }
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(b, "cameraLinkage") &&
    b.cameraLinkage
  ) {
    const c = b.cameraLinkage || {};
    if (c.enabled !== undefined && typeof c.enabled !== "boolean") {
      return "cameraLinkage.enabled 需為布林值";
    }
    if (!Array.isArray(c.camera_device_ids)) {
      return "cameraLinkage.camera_device_ids 需為陣列";
    }
    const ids = c.camera_device_ids
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0);
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) {
      return "cameraLinkage.camera_device_ids 不可重複";
    }
    if (unique.length === 0) {
      return "cameraLinkage.camera_device_ids 至少需 1 台";
    }
    if (unique.length > 4) {
      return "cameraLinkage.camera_device_ids 最多 4 台";
    }
  }

  if (Object.prototype.hasOwnProperty.call(b, "accessDoorLinkage")) {
    if (b.accessDoorLinkage && typeof b.accessDoorLinkage !== "object") {
      return "accessDoorLinkage 需為物件或 null";
    }
    if (b.accessDoorLinkage) {
      const a = b.accessDoorLinkage || {};
      if (a.enabled !== undefined && typeof a.enabled !== "boolean") {
        return "accessDoorLinkage.enabled 需為布林值";
      }
      if (a.device_ids !== undefined) {
        if (!Array.isArray(a.device_ids)) {
          return "accessDoorLinkage.device_ids 需為陣列";
        }
        const ids = a.device_ids
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0);
        const unique = [...new Set(ids)];
        if (unique.length !== ids.length) {
          return "accessDoorLinkage.device_ids 不可重複";
        }
        if (unique.length > ACCESS_DOOR_LINKAGE_MAX_DEVICE_IDS) {
          return `accessDoorLinkage.device_ids 最多 ${ACCESS_DOOR_LINKAGE_MAX_DEVICE_IDS} 台`;
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(b, "sipRingLinkage")) {
    if (b.sipRingLinkage && typeof b.sipRingLinkage !== "object") {
      return "sipRingLinkage 需為物件或 null";
    }
    if (b.sipRingLinkage) {
      const a = b.sipRingLinkage || {};
      if (a.enabled !== undefined && typeof a.enabled !== "boolean") {
        return "sipRingLinkage.enabled 需為布林值";
      }
      if (a.device_ids !== undefined) {
        if (!Array.isArray(a.device_ids)) {
          return "sipRingLinkage.device_ids 需為陣列";
        }
        const ids = a.device_ids
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0);
        const unique = [...new Set(ids)];
        if (unique.length !== ids.length) {
          return "sipRingLinkage.device_ids 不可重複";
        }
        if (unique.length > SIP_RING_LINKAGE_MAX_DEVICE_IDS) {
          return `sipRingLinkage.device_ids 最多 ${SIP_RING_LINKAGE_MAX_DEVICE_IDS} 台`;
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(b, "elevatorCallLinkage")) {
    if (b.elevatorCallLinkage && typeof b.elevatorCallLinkage !== "object") {
      return "elevatorCallLinkage 需為物件或 null";
    }
    if (b.elevatorCallLinkage) {
      const a = b.elevatorCallLinkage || {};
      if (a.enabled !== undefined && typeof a.enabled !== "boolean") {
        return "elevatorCallLinkage.enabled 需為布林值";
      }
      if (a.location_ids !== undefined) {
        if (!Array.isArray(a.location_ids)) {
          return "elevatorCallLinkage.location_ids 需為陣列";
        }
        const ids = a.location_ids
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0);
        const unique = [...new Set(ids)];
        if (unique.length !== ids.length) {
          return "elevatorCallLinkage.location_ids 不可重複";
        }
        if (unique.length > ELEVATOR_CALL_LINKAGE_MAX_LOCATION_IDS) {
          return `elevatorCallLinkage.location_ids 最多 ${ELEVATOR_CALL_LINKAGE_MAX_LOCATION_IDS} 筆`;
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(b, "emailSubscription")) {
    if (b.emailSubscription && typeof b.emailSubscription !== "object") {
      return "emailSubscription 需為物件或 null";
    }
    if (b.emailSubscription) {
      const e = b.emailSubscription || {};
      if (e.enabled !== undefined && typeof e.enabled !== "boolean") {
        return "emailSubscription.enabled 需為布林值";
      }
      const enabled = e.enabled !== undefined ? Boolean(e.enabled) : false;
      const security = String(e.smtp_security || "none")
        .trim()
        .toLowerCase();
      if (!["none", "ssl", "tls"].includes(security)) {
        return "emailSubscription.smtp_security 僅允許 none/ssl/tls";
      }
      if (enabled) {
        const host = String(e.smtp_host || "").trim();
        if (!host) return "emailSubscription.smtp_host 為必填";
        const portN = Number(e.smtp_port);
        if (!Number.isInteger(portN) || portN <= 0) {
          return "emailSubscription.smtp_port 為必填且需為正整數";
        }
        const fromEmail = String(e.smtp_user || "").trim();
        if (!fromEmail)
          return "emailSubscription.smtp_user（寄件人 Email）為必填";
        if (!looksLikeEmail(fromEmail)) {
          return "emailSubscription.smtp_user（寄件人 Email）格式不正確";
        }
        if (!Array.isArray(e.to_emails) || e.to_emails.length === 0) {
          return "emailSubscription.to_emails 為必填且需為陣列";
        }
      }

      if (e.to_emails !== undefined && !Array.isArray(e.to_emails)) {
        return "emailSubscription.to_emails 需為陣列";
      }
      if (e.repeat_min_interval_seconds !== undefined) {
        const n = Number(e.repeat_min_interval_seconds);
        if (!Number.isInteger(n) || n < 15) {
          return "emailSubscription.repeat_min_interval_seconds 需為整數且最小 15";
        }
      }
      if (e.repeat_max_send_count !== undefined) {
        const n = Number(e.repeat_max_send_count);
        if (!Number.isInteger(n) || n < 1 || n > 10) {
          return "emailSubscription.repeat_max_send_count 需為整數且介於 1~10";
        }
      }
    }
  }

  return null;
}

function pickDefined(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of Object.keys(obj)) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) {
      out[k] = obj[k];
    }
  }
  return out;
}

function mergeEmailSubscriptionForTest(storedRow, overrideObj) {
  const s = storedRow && typeof storedRow === "object" ? storedRow : {};
  const o = overrideObj && typeof overrideObj === "object" ? overrideObj : {};
  const p = pickDefined(o);

  const merged = { ...s, ...p };

  // 密碼欄位：允許用 null 清空；空字串視為 null（與 upsert 行為一致）
  if (Object.prototype.hasOwnProperty.call(p, "smtp_password")) {
    const pw = p.smtp_password;
    merged.smtp_password =
      pw == null || String(pw).trim() === "" ? null : String(pw);
  }

  return merged;
}

function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

function validateEmailSubscriptionForSmtpTest(sub) {
  const e = sub || {};
  const host = String(e.smtp_host || "").trim();
  if (!host) return "emailSubscription.smtp_host 為必填";
  const portN = Number(e.smtp_port);
  if (!Number.isInteger(portN) || portN <= 0) {
    return "emailSubscription.smtp_port 為必填且需為正整數";
  }
  const security = String(e.smtp_security || "none")
    .trim()
    .toLowerCase();
  if (!["none", "ssl", "tls"].includes(security)) {
    return "emailSubscription.smtp_security 僅允許 none/ssl/tls";
  }
  const fromEmail = String(e.smtp_user || "").trim();
  if (!fromEmail) return "emailSubscription.smtp_user（寄件人 Email）為必填";
  if (!looksLikeEmail(fromEmail)) {
    return "emailSubscription.smtp_user（寄件人 Email）格式不正確";
  }
  const toEmails = Array.isArray(e.to_emails) ? e.to_emails : null;
  if (!toEmails || toEmails.length === 0) {
    return "emailSubscription.to_emails 為必填且需為非空陣列";
  }
  const normalized = toEmails
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .slice(0, 20);
  if (normalized.length === 0) {
    return "emailSubscription.to_emails 不可為空";
  }
  for (const addr of normalized) {
    if (!looksLikeEmail(addr)) {
      return `emailSubscription.to_emails 含有不合法的 Email：${addr}`;
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

  if (
    payload.message_suffix !== undefined &&
    payload.message_suffix !== null &&
    typeof payload.message_suffix !== "string"
  ) {
    return "message_suffix 需為字串";
  }

  const condCfg = payload.condition_config;
  const allowedOpHint = `僅支援 ${ALLOWED_THRESHOLD_OPERATORS.join("、")}（不支援 = / ==）`;
  const opStr =
    condCfg?.operator === undefined ||
    condCfg?.operator === null ||
    condCfg?.operator === ""
      ? ""
      : String(condCfg.operator);
  const opOk = opStr !== "" && ALLOWED_THRESHOLD_OPERATORS.includes(opStr);
  if (opStr !== "" && !opOk) {
    return `threshold 的 operator 不合法，${allowedOpHint}`;
  }
  if (!allowPartial && condition_type === "threshold" && source !== "energy" && !opOk) {
    return `threshold 規則需提供 operator，且 ${allowedOpHint}`;
  }

  if (condition_type === "energy_contract_stage") {
    const level = Number(condition_config?.level);
    const pct = Number(condition_config?.threshold_pct);
    if (!Number.isInteger(level) || level < 1 || level > 3) {
      return "energy_contract_stage 需提供 level（1～3）";
    }
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      return "energy_contract_stage 需提供 threshold_pct（1～100）";
    }
  }

  if (condition_type === "energy_meter_stale") {
    const mins = Number(condition_config?.stale_minutes);
    if (!Number.isFinite(mins) || mins < 1) {
      return "energy_meter_stale 需提供 stale_minutes（>= 1）";
    }
  }

  if (condition_type === "energy_reading_jump") {
    const mult = Number(condition_config?.multiplier);
    const minKwh = Number(condition_config?.min_kwh);
    if (!Number.isFinite(mult) || mult < 1) {
      return "energy_reading_jump 需提供 multiplier（>= 1）";
    }
    if (!Number.isFinite(minKwh) || minKwh < 0) {
      return "energy_reading_jump 需提供 min_kwh（>= 0）";
    }
  }

  const effectiveConditionType =
    condition_type ??
    (alert_type === "threshold" ? "threshold" : undefined);
  if (effectiveConditionType === "threshold" && condCfg?.parameter != null) {
    const param = String(condCfg.parameter).trim();
    if (param && !isValidAlertThresholdParameterKey(param)) {
      const allowed = listAlertThresholdParameterKeys().join(", ");
      return `threshold 的 parameter 不合法：${param}（支援：${allowed}）`;
    }
  }
  if (
    !allowPartial &&
    effectiveConditionType === "threshold" &&
    source === "environment"
  ) {
    const param = condCfg?.parameter != null ? String(condCfg.parameter).trim() : "";
    if (!param || !isValidAlertThresholdParameterKey(param)) {
      const allowed = listAlertThresholdParameterKeys().join(", ");
      return `environment threshold 規則需提供合法的 parameter（支援：${allowed}）`;
    }
  }

  return null;
}

// 以下路由皆需登入
router.use(authenticate);

// 警示紀錄：以系統權限碼控管（核心基礎不走 license gate）
router.use(requirePermission("system.alert_log"));

// ========== 警示 API ==========

// 取得警示列表
router.get(
  "/",
  requireAlertExportIfBulk(),
  disableHttpCache,
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
      time_field,
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
      time_field,
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
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const {
      source,
      source_id,
      exclude_sources,
      alert_type,
      severity,
      start_date,
      end_date,
      time_field,
    } = req.query;

    const countResult = await alertService.getUnresolvedAlertCount({
      source,
      source_id: source_id ? parseInt(source_id) : undefined,
      exclude_sources,
      alert_type,
      severity,
      start_date,
      end_date,
      time_field,
    });

    res.sendSuccess(countResult);
  }),
);

// 取得警報規則（用於前端顯示狀態）
router.get(
  "/rules",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const { source, alert_type, parameter } = req.query;

    let rules;
    const hasSource = Boolean(source && String(source).trim());
    if (!hasSource) {
      // 未指定 source：回傳所有來源的啟用規則（供後台「全部系統」一次載入）
      rules = await alertRuleService.getAllRules(true);
    } else if (alert_type === "threshold") {
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

    // 讀取端保護：規則 severity 僅允許 warning/critical；若資料庫殘留 error，視為 critical
    const normalizedRules = (rules || []).map((r) => {
      const s = r?.severity;
      if (s === "warning" || s === "critical") return r;
      if (s === "error") return { ...r, severity: "critical" };
      return { ...r, severity: "warning" };
    });

    res.sendSuccess({ rules: normalizedRules });
  }),
);

// 批次取得多個規則的整合設定（DO／攝影機／門禁全開／Email）
router.post(
  "/rules/integrations/batch",
  requirePermission("system.alert_log.alert.update"),
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const raw = req.body || {};
    const ruleIds = Array.isArray(raw.ruleIds) ? raw.ruleIds : [];
    const ids = [...new Set(ruleIds.map((v) => Number(v)))]
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 1000);

    if (ids.length === 0) {
      return res.sendSuccess({});
    }

    const [
      doLinkages,
      cameraLinkages,
      accessDoorLinkages,
      sipRingLinkages,
      elevatorCallLinkages,
      emailSubs,
    ] = await Promise.all([
        alertLinkageService.getLatestLinkagesByRuleIds(ids),
        alertCameraLinkageService.getByRuleIds(ids),
        alertAccessDoorLinkageService.getByRuleIds(ids),
        alertSipRingLinkageService.getByRuleIds(ids),
        alertElevatorCallLinkageService.getByRuleIds(ids),
        alertEmailSubscriptionService.getByRuleIds(ids),
      ]);

    const result = {};
    for (const id of ids) {
      result[id] = {
        doLinkage: null,
        cameraLinkage: null,
        accessDoorLinkage: null,
        sipRingLinkage: null,
        elevatorCallLinkage: null,
        emailSubscription: null,
      };
    }

    for (const d of doLinkages || []) {
      const rid = d?.rule_id != null ? Number(d.rule_id) : null;
      if (!rid || !result[rid]) continue;
      result[rid].doLinkage = d;
    }
    for (const c of cameraLinkages || []) {
      const rid = c?.rule_id != null ? Number(c.rule_id) : null;
      if (!rid || !result[rid]) continue;
      result[rid].cameraLinkage = await filterLinkageByLicense(c, "surveillance");
    }
    for (const a of accessDoorLinkages || []) {
      const rid = a?.rule_id != null ? Number(a.rule_id) : null;
      if (!rid || !result[rid]) continue;
      result[rid].accessDoorLinkage = await filterLinkageByLicense(
        a,
        "people_counting",
      );
    }
    for (const s of sipRingLinkages || []) {
      const rid = s?.rule_id != null ? Number(s.rule_id) : null;
      if (!rid || !result[rid]) continue;
      result[rid].sipRingLinkage = await filterLinkageByLicense(
        s,
        "access_security",
      );
    }
    for (const e of elevatorCallLinkages || []) {
      const rid = e?.rule_id != null ? Number(e.rule_id) : null;
      if (!rid || !result[rid]) continue;
      result[rid].elevatorCallLinkage = await filterLinkageByLicense(
        e,
        "elevator",
      );
    }
    for (const e of emailSubs || []) {
      const rid = e?.rule_id != null ? Number(e.rule_id) : null;
      if (!rid || !result[rid]) continue;
      result[rid].emailSubscription = e;
    }

    return res.sendSuccess(result);
  }),
);

// 規則訊息預覽 API 已移除（訊息模板固定 + 後綴，前端不提供預覽）

// 建立警報規則（system.alert_log.alert.create）
router.post(
  "/rules",
  requirePermission("system.alert_log.alert.create"),
  asyncHandler(async (req, res) => {
    if (String(req.body?.source || "").trim() === "energy") {
      throwApiError(
        C.ALERT_VALIDATION_FAILED,
        "能源 Incident 門檻請至能源參數設定維護；規則由系統預設建立，不可由此新增",
      );
    }

    const validationError = validateRulePayload(req.body, {
      allowPartial: false,
    });
    if (validationError) {
      throwApiError(C.ALERT_VALIDATION_FAILED, validationError);
    }

    const rule = await alertRuleService.createAlertRule(req.body);
    res.sendSuccess({ rule });
  }),
);

// 取得單一規則的整合設定（連動 DO / 攝影機 / 門禁全開 / SIP 語音廣播 / 電梯呼梯 / Email）
router.get(
  "/rules/:id/integrations",
  requirePermission("system.alert_log"),
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const ruleId = Number(req.params.id);
    res.sendSuccess(await getFilteredIntegrationsForRule(ruleId));
  }),
);

// 更新單一規則的整合設定（以 rule_id 為主鍵 upsert）
router.put(
  "/rules/:id/integrations",
  requirePermission("system.alert_log.alert.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const ruleId = Number(req.params.id);
    const userId = req.user?.id ?? null;
    const body = req.body || {};

    const integrationErr = validateRuleIntegrationsPayload(body);
    if (integrationErr) {
      throwApiError(C.ALERT_VALIDATION_FAILED, integrationErr);
    }

    // DO linkage
    if (Object.prototype.hasOwnProperty.call(body, "doLinkage")) {
      if (!body.doLinkage) {
        await alertLinkageService.deleteAllLinkagesForRule(ruleId);
      } else {
        await alertLinkageService.upsertSingleLinkageForRule(
          ruleId,
          body.doLinkage,
          userId,
        );
      }
    }

    // Camera linkage
    if (Object.prototype.hasOwnProperty.call(body, "cameraLinkage")) {
      if (!body.cameraLinkage) {
        await alertCameraLinkageService.deleteForRule(ruleId);
      } else {
        await assertLinkageLicensedForUpsert(body.cameraLinkage, "surveillance");
        await alertCameraLinkageService.upsertForRule(
          ruleId,
          body.cameraLinkage,
          userId,
        );
      }
    }

    // Access door linkage（device_ids 空＝全部；有值＝指定）
    if (Object.prototype.hasOwnProperty.call(body, "accessDoorLinkage")) {
      if (!body.accessDoorLinkage) {
        await alertAccessDoorLinkageService.deleteForRule(ruleId);
      } else {
        await assertLinkageLicensedForUpsert(
          body.accessDoorLinkage,
          "people_counting",
        );
        await alertAccessDoorLinkageService.upsertForRule(
          ruleId,
          body.accessDoorLinkage,
          userId,
        );
      }
    }

    // SIP 室內語音廣播連動（device_ids 空＝全部室內機）
    if (Object.prototype.hasOwnProperty.call(body, "sipRingLinkage")) {
      if (!body.sipRingLinkage) {
        await alertSipRingLinkageService.deleteForRule(ruleId);
      } else {
        await assertLinkageLicensedForUpsert(body.sipRingLinkage, "access_security");
        await alertSipRingLinkageService.upsertForRule(
          ruleId,
          body.sipRingLinkage,
          userId,
        );
      }
    }

    // 電梯呼梯至 1F（location_ids 空＝全部電梯地點）
    if (Object.prototype.hasOwnProperty.call(body, "elevatorCallLinkage")) {
      if (!body.elevatorCallLinkage) {
        await alertElevatorCallLinkageService.deleteForRule(ruleId);
      } else {
        await assertLinkageLicensedForUpsert(body.elevatorCallLinkage, "elevator");
        await alertElevatorCallLinkageService.upsertForRule(
          ruleId,
          body.elevatorCallLinkage,
          userId,
        );
      }
    }

    // Email subscription (upsert)
    if (Object.prototype.hasOwnProperty.call(body, "emailSubscription")) {
      if (!body.emailSubscription) {
        await alertEmailSubscriptionService.deleteForRule(ruleId);
      } else {
        await alertEmailSubscriptionService.upsertForRule(
          ruleId,
          body.emailSubscription,
          userId,
        );
      }
    }

    res.sendSuccess(await getFilteredIntegrationsForRule(ruleId));
  }),
);

// SMTP 測試寄信（system.alert_log；不寫入 DB）
router.post(
  "/rules/:id/email/test",
  requirePermission("system.alert_log.alert.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const ruleId = Number(req.params.id);
    const body = req.body || {};

    const ruleRows = await db.query(
      "SELECT id FROM alert_rules WHERE id = ? LIMIT 1",
      [ruleId],
    );
    if (!ruleRows?.[0]) {
      throwApiError(C.ALERT_RULE_NOT_FOUND, "找不到指定的規則", { statusCode: 404 });
    }

    const stored = await alertEmailSubscriptionService.getByRuleId(ruleId);
    const merged = mergeEmailSubscriptionForTest(
      stored,
      body.emailSubscription,
    );

    const errMsg = validateEmailSubscriptionForSmtpTest(merged);
    if (errMsg) {
      throwApiError(C.ALERT_VALIDATION_FAILED, errMsg);
    }

    const security = String(merged.smtp_security || "none")
      .trim()
      .toLowerCase();
    const userRaw =
      merged.smtp_user != null ? String(merged.smtp_user).trim() : "";
    const passRaw =
      merged.smtp_password != null ? String(merged.smtp_password) : "";

    const toList = Array.isArray(merged.to_emails)
      ? merged.to_emails
          .map((v) => String(v || "").trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];

    const subject = `[BA] SMTP 測試（rule_id=${ruleId}）`;
    const text = [
      "這是一封 BA 系統的 SMTP 測試信。",
      "",
      `rule_id: ${ruleId}`,
      `時間: ${new Date().toISOString()}`,
      "",
      "若你收到此信，代表 SMTP 設定（連線/認證/寄送）可用。",
    ].join("\n");

    try {
      const info = await sendSmtpMailAndClose(
        {
          host: String(merged.smtp_host || "").trim(),
          port: Number(merged.smtp_port),
          user: userRaw || null,
          password: passRaw || null,
          security,
        },
        { to: toList, subject, text },
      );

      return res.sendSuccess({
        ok: true,
        messageId: info?.messageId ?? null,
        accepted: info?.accepted ?? null,
        rejected: info?.rejected ?? null,
        response: info?.response ?? null,
      });
    } catch (e) {
      const code = String(e?.code || "");
      const msg = String(e?.message || e || "SMTP_SEND_FAILED");
      if (
        msg.includes("SMTP_HOST_REQUIRED") ||
        msg.includes("SMTP_PORT_REQUIRED") ||
        msg.includes("SMTP_SECURITY_INVALID")
      ) {
        throwApiError(C.ALERT_SMTP_INVALID, "SMTP 設定不完整或不合法");
      }
      throwApiError(
        C.ALERT_SMTP_SEND_FAILED,
        `SMTP 測試寄送失敗：${code ? `${code} ` : ""}${msg}`,
        { statusCode: 502 },
      );
    }
  }),
);

// 更新警報規則（system.alert_log.alert.update）
router.put(
  "/rules/:id",
  requirePermission("system.alert_log.alert.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const ruleId = parseInt(id, 10);
    const existingRows = await db.query(
      "SELECT source FROM alert_rules WHERE id = ? LIMIT 1",
      [ruleId],
    );
    const existingSource = existingRows?.[0]?.source;

    // 能源門檻 SSOT 在能源參數設定；警示紀錄僅可改啟用／嚴重度／名稱／後綴等
    let updates = { ...(req.body || {}) };
    if (String(existingSource || "") === "energy") {
      delete updates.source;
      delete updates.alert_type;
      delete updates.condition_type;
      delete updates.condition_config;
      delete updates.dimension_key;
      delete updates.message_template_key;
      delete updates.message_template_custom;
      delete updates.message_template;
    }

    const validationError = validateRulePayload(updates, {
      allowPartial: true,
    });
    if (validationError) {
      throwApiError(C.ALERT_VALIDATION_FAILED, validationError);
    }

    const rule = await alertRuleService.updateAlertRule(ruleId, updates);
    res.sendSuccess({ rule });
  }),
);

// 刪除警報規則（system.alert_log.alert.delete）
router.delete(
  "/rules/:id",
  requirePermission("system.alert_log.alert.delete"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const rule = await alertRuleService.deleteAlertRule(parseInt(id));
    res.sendSuccess({ rule });
  }),
);

// 取得單一警示
router.get(
  "/:id",
  disableHttpCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const alert = await alertService.getAlertById(parseInt(id));
    res.sendSuccess({ alert });
  }),
);

// 注意：警報由系統自動解決，不提供手動解決的端點
// 系統會在檢測到問題恢復時自動將警報標記為已解決

// 標記警示為未解決（system.alert_log.alert.update）
router.put(
  "/:id/unresolve",
  requirePermission("system.alert_log.alert.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) {
      throwApiError(C.AUTH_CONTEXT_MISSING, "未提供認證資訊", { statusCode: 401 });
    }
    const result = await alertService.unresolveAlert(parseInt(id), userId);
    res.sendSuccess({ alert: result });
  }),
);

// 忽視警示（system.alert_log.alert.ignore）
router.post(
  "/:deviceId/:alertType/ignore",
  requirePermission("system.alert_log.alert.ignore"),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const { deviceId, alertType } = req.params;
    const { source, dimension_key } = req.query; // 可選的系統來源/維度參數
    const userId = req.user?.id;
    if (!userId) {
      throwApiError(C.AUTH_CONTEXT_MISSING, "未提供認證資訊", { statusCode: 401 });
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

// 取消忽視警示（system.alert_log.alert.ignore）
router.post(
  "/:deviceId/:alertType/unignore",
  requirePermission("system.alert_log.alert.ignore"),
  validateIntegers("deviceId"),
  asyncHandler(async (req, res) => {
    const { deviceId, alertType } = req.params;
    const { source, dimension_key } = req.query; // 可選的系統來源/維度參數

    const count = await alertIgnoreService.unignoreAlerts(
      parseInt(deviceId),
      alertType,
      source, // 如果未提供，默認為 device（向後兼容）
      dimension_key || null,
    );
    res.sendSuccess({ message: `已取消忽視 ${count} 個警示`, count });
  }),
);

module.exports = router;
