const express = require("express");
const router = express.Router();
const alertService = require("../services/alerts/alertService");
const alertIgnoreService = require("../services/alerts/alertIgnoreService");
const alertRuleService = require("../services/alerts/alertRuleService");
const alertLinkageService = require("../services/alerts/alertLinkageService");
const alertCameraLinkageService = require("../services/alerts/alertCameraLinkageService");
const alertEmailSubscriptionService = require("../services/alerts/alertEmailSubscriptionService");
const db = require("../database/db");
const { sendSmtpMailAndClose } = require("../services/notifications/mailer");
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
];

/** 閾值條件運算子（不支援 = / ==） */
const ALLOWED_THRESHOLD_OPERATORS = [">", ">=", "<", "<="];

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
      const security = String(e.smtp_security || "none").trim().toLowerCase();
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
        if (!fromEmail) return "emailSubscription.smtp_user（寄件人 Email）為必填";
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
  const security = String(e.smtp_security || "none").trim().toLowerCase();
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
  if (!allowPartial && condition_type === "threshold" && !opOk) {
    return `threshold 規則需提供 operator，且 ${allowedOpHint}`;
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

// 批次取得多個規則的整合設定（DO / 攝影機 / Email）
router.post(
  "/rules/integrations/batch",
  requireAdminOrOperator,
  noCache,
  asyncHandler(async (req, res) => {
    const raw = req.body || {};
    const ruleIds = Array.isArray(raw.ruleIds) ? raw.ruleIds : [];
    const ids = [...new Set(ruleIds.map((v) => Number(v)))]
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 1000);

    if (ids.length === 0) {
      return res.sendSuccess({});
    }

    const [doLinkages, cameraLinkages, emailSubs] = await Promise.all([
      alertLinkageService.getLatestLinkagesByRuleIds(ids),
      alertCameraLinkageService.getByRuleIds(ids),
      alertEmailSubscriptionService.getByRuleIds(ids),
    ]);

    const result = {};
    for (const id of ids) {
      result[id] = {
        doLinkage: null,
        cameraLinkage: null,
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
      result[rid].cameraLinkage = c;
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

// 取得單一規則的整合設定（連動 DO / 攝影機 / Email）
router.get(
  "/rules/:id/integrations",
  requireAdminOrOperator,
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const ruleId = Number(req.params.id);
    const doLinkage =
      await alertLinkageService.getSingleLinkageByRuleId(ruleId);
    const cameraLinkage = await alertCameraLinkageService.getByRuleId(ruleId);
    const emailSubscription = await alertEmailSubscriptionService.getByRuleId(ruleId);
    res.sendSuccess({ doLinkage, cameraLinkage, emailSubscription });
  }),
);

// 更新單一規則的整合設定（以 rule_id 為主鍵 upsert）
router.put(
  "/rules/:id/integrations",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const ruleId = Number(req.params.id);
    const userId = req.user?.id ?? null;
    const body = req.body || {};

    const integrationErr = validateRuleIntegrationsPayload(body);
    if (integrationErr) return res.sendError(integrationErr, 400);

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
        await alertCameraLinkageService.upsertForRule(
          ruleId,
          body.cameraLinkage,
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

    const doLinkage =
      await alertLinkageService.getSingleLinkageByRuleId(ruleId);
    const cameraLinkage = await alertCameraLinkageService.getByRuleId(ruleId);
    const emailSubscription = await alertEmailSubscriptionService.getByRuleId(ruleId);
    res.sendSuccess({ doLinkage, cameraLinkage, emailSubscription });
  }),
);

// SMTP 測試寄信（admin/operator；不寫入 DB；可用 body.emailSubscription 覆寫設定）
router.post(
  "/rules/:id/email/test",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const ruleId = Number(req.params.id);
    const body = req.body || {};

    const ruleRows = await db.query(
      "SELECT id FROM alert_rules WHERE id = ? LIMIT 1",
      [ruleId],
    );
    if (!ruleRows?.[0]) {
      return res.sendError("找不到指定的規則", 404);
    }

    const stored = await alertEmailSubscriptionService.getByRuleId(ruleId);
    const merged = mergeEmailSubscriptionForTest(stored, body.emailSubscription);

    const errMsg = validateEmailSubscriptionForSmtpTest(merged);
    if (errMsg) return res.sendError(errMsg, 400);

    const security = String(merged.smtp_security || "none").trim().toLowerCase();
    const userRaw = merged.smtp_user != null ? String(merged.smtp_user).trim() : "";
    const passRaw =
      merged.smtp_password != null ? String(merged.smtp_password) : "";

    const toList = Array.isArray(merged.to_emails)
      ? merged.to_emails.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 20)
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
        return res.sendError("SMTP 設定不完整或不合法", 400);
      }
      return res.sendError(`SMTP 測試寄送失敗：${code ? `${code} ` : ""}${msg}`, 502);
    }
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
