/**
 * 警報規則服務
 * 提供規則查詢、條件評估和訊息格式化功能
 */

const db = require("../../database/db");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const ruleLogger = logger.createLogger("alertRuleService");

/** 與前端約定：規則訊息以 canonical 模板 + 變數渲染（觸發時由 renderRuleMessage 統一處理） */
const MESSAGE_TEMPLATE_KEYS = {
  THRESHOLD_V1: "rule.threshold.v1",
  OFFLINE_V1: "rule.offline.v1",
  DI_V1: "rule.di.v1",
  DO_V1: "rule.do.v1",
  CUSTOM: "custom",
};

/** Canonical 與自訂模板皆應以 `{location_label}` 為唯一來源前綴占位（執行時會正規化舊版双占位／舊 source 占位） */
const CANONICAL_TEMPLATES = {
  [MESSAGE_TEMPLATE_KEYS.THRESHOLD_V1]:
    "{location_label} {parameter_name} {operator} {threshold}{unit}（當前 {current_value}{unit}）",
  [MESSAGE_TEMPLATE_KEYS.OFFLINE_V1]:
    "{location_label} 連續 {error_count} 次無法連接",
  [MESSAGE_TEMPLATE_KEYS.DI_V1]: "{location_label} DI {di_address} 觸發",
  [MESSAGE_TEMPLATE_KEYS.DO_V1]: "{location_label} DO {do_address} 觸發",
};

const LOCATION_SYSTEM_SOURCES = new Set([
  "environment",
  "lighting",
  "drainage",
  "power",
  "hvac",
  "air_circulation",
  "people_counting",
  "fire",
  "emergency_rescue",
  "smoke_alarm",
]);

const {
  getParameterDisplayName: getCatalogParameterDisplayName,
} = require("../../constants/environmentParameterCatalog");

function inferDefaultTemplateKey(alertType) {
  if (alertType === "threshold") return MESSAGE_TEMPLATE_KEYS.THRESHOLD_V1;
  if (alertType === "offline") return MESSAGE_TEMPLATE_KEYS.OFFLINE_V1;
  if (alertType === "di") return MESSAGE_TEMPLATE_KEYS.DI_V1;
  if (alertType === "do") return MESSAGE_TEMPLATE_KEYS.DO_V1;
  /** incident 用 error；舊排水規則可能仍為 error，無 canonical，改以 message_template 為準 */
  return null;
}

function getCanonicalTemplateString(key) {
  return CANONICAL_TEMPLATES[key] || "";
}

/** 訊息模板 {operator}：僅「超過／低於」（與前端列表、預覽一致） */
function getThresholdOperatorDisplayLabel(operator) {
  const op = String(operator ?? "").trim();
  if (op === ">" || op === ">=") return "超過";
  if (op === "<" || op === "<=") return "低於";
  return "";
}

/**
 * 依 location_systems.id（即警報的 source_id）解析區域／地點名稱
 * —— 與規則 target 無關，供訊息前綴「區域 - 地點」一致顯示
 */
async function getZoneLocationPairByLocationSystemId(locationSystemId) {
  if (locationSystemId == null || !Number.isFinite(Number(locationSystemId))) {
    return { zone_name: "", location_name: "" };
  }
  const r = await db.query(
    `SELECT z.name AS zone_name, l.name AS location_name
     FROM location_systems ls
     JOIN locations l ON l.id = ls.location_id
     JOIN zones z ON z.id = l.zone_id
     WHERE ls.id = ?
     LIMIT 1`,
    [locationSystemId],
  );
  return {
    zone_name: r?.[0]?.zone_name || "",
    location_name: r?.[0]?.location_name || "",
  };
}

/** 「區域 - 地點」；缺其一則只顯示有名稱的一方 */
function formatZoneDashLocation(zoneName, locationName) {
  const z = String(zoneName || "").trim();
  const l = String(locationName || "").trim();
  if (z && l) return `${z} - ${l}`;
  if (l) return l;
  if (z) return z;
  return "";
}

async function getTargetLabels(targetType, targetId) {
  if (!targetType || targetId == null || !Number.isFinite(Number(targetId))) {
    return { zone_name: "", location_name: "" };
  }
  if (targetType === "zone") {
    const r = await db.query("SELECT name FROM zones WHERE id = ? LIMIT 1", [
      targetId,
    ]);
    return { zone_name: r?.[0]?.name || "", location_name: "" };
  }
  if (targetType === "location") {
    const r = await db.query(
      `SELECT l.name AS location_name, z.name AS zone_name
       FROM locations l
       JOIN zones z ON z.id = l.zone_id
       WHERE l.id = ?
       LIMIT 1`,
      [targetId],
    );
    return {
      zone_name: r?.[0]?.zone_name || "",
      location_name: r?.[0]?.location_name || "",
    };
  }
  return { zone_name: "", location_name: "" };
}

/** 規則「目標」對應的區域名／地點名，統一套用「區域 - 地點」後再包全形括號（無則空字串） */
async function computeZoneLocationSuffix(rule) {
  const { zone_name, location_name } = await getTargetLabels(
    rule.target_type,
    rule.target_id,
  );
  const inner = formatZoneDashLocation(zone_name, location_name);
  if (!inner) return "";
  return `（${inner}）`;
}

function extractIoAddress(rule) {
  const m = String(rule?.condition_config?.bit_key || "").match(
    /^(di|do):(\d+)$/i,
  );
  return m ? m[2] : "1";
}

function resolveRuleTemplate(rule) {
  const key = rule.message_template_key;
  if (key && CANONICAL_TEMPLATES[key]) {
    return CANONICAL_TEMPLATES[key];
  }
  if (rule.message_template) {
    return rule.message_template;
  }
  const fb = inferDefaultTemplateKey(rule.alert_type);
  return fb ? CANONICAL_TEMPLATES[fb] || "" : "";
}

/**
 * 舊版模板升级为單一 `{location_label}`，避免再注入 source_display_name／source_name
 */
function normalizeAlertRuleTemplate(template) {
  if (template == null || typeof template !== "string") return template;
  return template
    .replace(
      /\{source_display_name\}\{zone_location_suffix\}/g,
      "{location_label}",
    )
    .replace(/\{source_name\}\{zone_location_suffix\}/g, "{location_label}")
    .replace(/\{source_display_name\}/g, "{location_label}")
    .replace(/\{source_name\}/g, "{location_label}");
}

async function resolveSourceDisplayNameForRule(rule, sourceId) {
  if (sourceId == null || !Number.isFinite(Number(sourceId))) {
    return "";
  }
  if (rule.source === "device") {
    const r = await db.query("SELECT name FROM devices WHERE id = ? LIMIT 1", [
      sourceId,
    ]);
    return r?.[0]?.name || `device:${sourceId}`;
  }
  return `${rule.source}:${sourceId}`;
}

/**
 * 訊息前綴：來源顯示名 + 規則「目標」括號後綴（非 location_system 來源／或無法由 DB 解析區域-地點時）
 * location_system 來源：優先一次查詢 `區域 - 地點`，成功則不再查規則目標後綴（避免重複與多餘查詢）
 */
async function resolveMessageLocationPrefix(rule, runtimeVars) {
  const sid =
    runtimeVars.source_id != null &&
    Number.isFinite(Number(runtimeVars.source_id))
      ? Number(runtimeVars.source_id)
      : null;

  let displayName = String(
    runtimeVars.source_display_name ?? runtimeVars.source_name ?? "",
  ).trim();

  if (LOCATION_SYSTEM_SOURCES.has(rule.source) && sid != null) {
    const pair = await getZoneLocationPairByLocationSystemId(sid);
    const canonicalLoc = formatZoneDashLocation(
      pair.zone_name,
      pair.location_name,
    );
    if (canonicalLoc) {
      return { displayName: canonicalLoc, zoneLocationSuffix: "" };
    }
    const zoneSuffix = await computeZoneLocationSuffix(rule);
    if (!displayName) {
      displayName = `${rule.source}:${sid}`;
    }
    return { displayName, zoneLocationSuffix: zoneSuffix };
  }

  const zoneSuffix = await computeZoneLocationSuffix(rule);
  if (!displayName && sid != null) {
    displayName = await resolveSourceDisplayNameForRule(rule, sid);
  }
  return { displayName, zoneLocationSuffix: zoneSuffix };
}

/**
 * 解析模板字串與替換變數（供 render / preview 共用，只 resolve 一次模板）
 */
async function buildRuleMessageRenderContext(rule, runtimeVars = {}) {
  const cfg = rule.condition_config || {};
  const ioAddr = extractIoAddress(rule);
  const diAddress = rule.alert_type === "di" ? ioAddr : "";
  const doAddress = rule.alert_type === "do" ? ioAddr : "";

  const { displayName, zoneLocationSuffix } =
    await resolveMessageLocationPrefix(rule, runtimeVars);

  const location_label = `${displayName}${zoneLocationSuffix}`;

  const paramLabel = getParameterDisplayName(cfg.parameter);
  const currentVal = String(
    runtimeVars.current_value ?? runtimeVars.value ?? "",
  );
  const operatorLabel =
    rule.alert_type === "threshold"
      ? getThresholdOperatorDisplayLabel(cfg.operator)
      : String(cfg.operator ?? "");
  const {
    source_display_name: _omitSd,
    source_name: _omitSn,
    ...restRuntime
  } = runtimeVars;
  const vars = {
    ...restRuntime,
    location_label: location_label,
    zone_location_suffix: zoneLocationSuffix,
    parameter_name: paramLabel,
    /** 舊版模板可能使用 {parameter} / {value} */
    parameter: paramLabel,
    value: currentVal,
    operator: operatorLabel,
    threshold: cfg.value != null ? String(cfg.value) : "",
    unit: cfg.unit ?? "",
    di_address: diAddress,
    do_address: doAddress,
    current_value: currentVal,
    error_count:
      runtimeVars.error_count != null ? String(runtimeVars.error_count) : "",
  };

  const template = normalizeAlertRuleTemplate(resolveRuleTemplate(rule));
  return { template, vars };
}

/**
 * 產出正規化模板 + 套用變數後字串（render / preview 共用）
 */
async function formatRuleMessageFromContext(rule, runtimeVars) {
  const { template, vars } = await buildRuleMessageRenderContext(
    rule,
    runtimeVars,
  );
  return { template, rendered: formatMessage(template, vars) };
}

/**
 * 依規則與執行時變數產生警報訊息（SSOT：後端統一渲染）
 * @param {Object} rule - alert_rules 列
 * @param {Object} runtimeVars - source_id?, current_value?, value?, error_count?, …（來源前綴請依模板使用 {location_label}；可選傳 source_display_name 供無法解析 DB 時兜底）
 */
async function renderRuleMessage(rule, runtimeVars = {}) {
  const { rendered } = await formatRuleMessageFromContext(rule, runtimeVars);
  const suffix =
    rule?.message_suffix != null ? String(rule.message_suffix) : "";
  return rendered + suffix;
}

/**
 * 規則表單預覽（不寫入 DB）
 */
function inferConditionTypeFromAlertType(alertType) {
  if (alertType === "threshold") return "threshold";
  if (alertType === "offline") return "error_count";
  if (alertType === "di" || alertType === "do") return "bit_state";
  return null;
}

async function previewRuleMessage(payload) {
  const conditionType =
    payload.condition_type ||
    inferConditionTypeFromAlertType(payload.alert_type);
  const ruleLike = {
    source: payload.source,
    alert_type: payload.alert_type,
    target_type: payload.target_type ?? null,
    target_id: payload.target_id ?? null,
    condition_type: conditionType,
    condition_config: payload.condition_config || {},
    message_template_key:
      payload.message_template_key ||
      inferDefaultTemplateKey(payload.alert_type) ||
      MESSAGE_TEMPLATE_KEYS.THRESHOLD_V1,
    message_template_custom: Boolean(payload.message_template_custom),
    message_template: payload.message_template || null,
  };
  const sampleVars = {
    source_display_name: payload.sample_source_display_name || "範例來源",
    source_id:
      payload.sample_source_id != null &&
      Number.isFinite(Number(payload.sample_source_id))
        ? Number(payload.sample_source_id)
        : undefined,
    current_value:
      payload.sample_current_value != null
        ? String(payload.sample_current_value)
        : "—",
    error_count:
      payload.sample_error_count != null
        ? String(payload.sample_error_count)
        : "5",
  };
  return formatRuleMessageFromContext(ruleLike, sampleVars);
}

function resolvePersistedTemplateFields(payload) {
  const alertType = payload.alert_type;
  // 訊息模板固定：一律使用 canonical（不允許 custom 全文）
  let key =
    inferDefaultTemplateKey(alertType) || MESSAGE_TEMPLATE_KEYS.THRESHOLD_V1;
  if (!CANONICAL_TEMPLATES[key]) {
    key = MESSAGE_TEMPLATE_KEYS.THRESHOLD_V1;
  }
  const messageTemplate = key ? getCanonicalTemplateString(key) : "";
  return {
    message_template_key: key,
    message_template_custom: false,
    message_template: messageTemplate,
  };
}

/**
 * 嚴重程度排序（用於規則匹配優先級）
 */
const SEVERITY_ORDER = {
  critical: 1,
  error: 2,
  warning: 3,
};

/**
 * 閾值規則快取（以 source 為 key）
 * 注意：規則可被新增/編輯/刪除，所以快取必須在 CRUD 後清除（見 create/update/delete 內 clearThresholdRulesCache）。
 */
const thresholdRulesCache = new Map();

/**
 * 清除指定來源的閾值規則緩存（當規則更新時調用）
 * @param {string} source - 系統來源
 */
function clearThresholdRulesCache(source = null) {
  if (source) {
    thresholdRulesCache.delete(source);
  } else {
    thresholdRulesCache.clear();
  }
}

/**
 * 查詢警報規則
 * @param {string} source - 系統來源
 * @param {string} alertType - 警報類型
 * @param {boolean} enabled - 是否只查詢啟用的規則（預設 true）
 * @returns {Promise<Array>} 規則列表
 */
async function getAlertRules(source, alertType, enabled = true) {
  try {
    let query = `
      SELECT * FROM alert_rules
      WHERE source = ? AND alert_type = ?
    `;
    const params = [source, alertType];

    if (enabled) {
      query += " AND enabled = TRUE";
    }

    query +=
      " ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 WHEN 'warning' THEN 3 END, id DESC";

    const result = await db.query(query, params);
    return result || [];
  } catch (error) {
    ruleLogger.error("查詢規則失敗", {
      source,
      alertType,
      error: error?.message || String(error),
      module: "alertRuleService",
    });
    return [];
  }
}

/**
 * 查詢閾值規則（帶快取；CRUD 後會清除快取）
 * @param {string} source - 系統來源
 * @param {string} parameter - 參數名稱（可選）
 * @returns {Promise<Array>} 閾值規則列表
 */
async function getThresholdRules(source, parameter = null) {
  try {
    // 檢查緩存
    const cacheKey = source;
    let cached = thresholdRulesCache.get(cacheKey);

    // 如果緩存不存在，從資料庫查詢並緩存
    if (!cached) {
      const query = `
        SELECT * FROM alert_rules
        WHERE source = ? 
          AND alert_type = 'threshold'
          AND condition_type = 'threshold'
          AND enabled = TRUE
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 WHEN 'warning' THEN 3 END, id DESC
      `;

      const result = await db.query(query, [source]);
      const rules = result || [];

      // 快取：避免 monitor 每輪重複查 DB；規則變更時會清除
      thresholdRulesCache.set(cacheKey, {
        rules: rules,
        timestamp: Date.now(),
      });

      cached = thresholdRulesCache.get(cacheKey);
    }

    // 如果指定了參數，過濾出該參數的規則
    if (parameter) {
      return cached.rules.filter(
        (rule) => rule.condition_config?.parameter === parameter,
      );
    }

    return cached.rules;
  } catch (error) {
    ruleLogger.error("查詢閾值規則失敗", {
      source,
      parameter,
      error: error?.message || String(error),
      module: "alertRuleService",
    });
    return [];
  }
}

/**
 * 查詢該來源的所有啟用規則（避免前端多次請求）
 * @param {string} source
 * @param {boolean} enabled - 是否只查詢啟用的規則（預設 true）
 * @returns {Promise<Array>}
 */
async function getAllRulesForSource(source, enabled = true) {
  try {
    let query = `
      SELECT * FROM alert_rules
      WHERE source = ?
    `;
    const params = [source];

    if (enabled) {
      query += " AND enabled = TRUE";
    }

    query +=
      " ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 WHEN 'warning' THEN 3 END, id DESC";

    const result = await db.query(query, params);
    return result || [];
  } catch (error) {
    ruleLogger.error("查詢來源所有規則失敗", {
      source,
      error: error?.message || String(error),
      module: "alertRuleService",
    });
    return [];
  }
}

function normalizeRuleDimensionValue(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase().replace(/\s+/g, "_");
}

function deriveRuleDimensionKey({
  alert_type,
  condition_type,
  condition_config,
}) {
  const alertType = normalizeRuleDimensionValue(alert_type);
  const conditionType = normalizeRuleDimensionValue(condition_type);
  const config = condition_config || {};

  if (alertType === "threshold" && conditionType === "threshold") {
    const parameter = normalizeRuleDimensionValue(config.parameter);
    return parameter ? `threshold:${parameter}` : "threshold:default";
  }

  if (alertType === "offline" && conditionType === "error_count") {
    return "offline:default";
  }

  if (
    (alertType === "di" || alertType === "do") &&
    conditionType === "bit_state"
  ) {
    const bitKeyRaw =
      typeof config.bit_key === "string" ? config.bit_key.trim() : "";
    const bitKey = bitKeyRaw.toLowerCase();
    // 規格化硬體位址：di|do|discrete|coil + 通道（與 diDoMonitor／statusPoints 一致）
    const match = bitKey.match(/^(di|do|discrete|coil):(\d+)$/);
    if (match) {
      const channel = match[2];
      if (alertType === "di") {
        return channel ? `di:ch:${channel}` : "di:default";
      }
      return channel ? `do:ch:${channel}` : "do:default";
    }
    const safe = normalizeRuleDimensionValue(bitKeyRaw);
    if (alertType === "di") {
      return safe ? `di:sem:${safe}` : "di:default";
    }
    return safe ? `do:sem:${safe}` : "do:default";
  }

  return alertType ? `${alertType}:default` : "default";
}

/**
 * 查詢錯誤次數規則
 * @param {string} source - 系統來源
 * @param {string} alertType - 警報類型
 * @returns {Promise<Object|null>} 錯誤次數規則（如果存在）
 */
async function getErrorCountRule(source, alertType) {
  try {
    const query = `
      SELECT * FROM alert_rules
      WHERE source = ?
        AND alert_type = ?
        AND condition_type = 'error_count'
        AND enabled = TRUE
      ORDER BY id DESC
      LIMIT 1
    `;

    const result = await db.query(query, [source, alertType]);
    return result && result.length > 0 ? result[0] : null;
  } catch (error) {
    ruleLogger.error("查詢錯誤次數規則失敗", {
      source,
      alertType,
      error: error?.message || String(error),
      module: "alertRuleService",
    });
    return null;
  }
}

/**
 * 建立警報規則
 * @param {Object} payload
 * @returns {Promise<Object>} 建立後的規則
 */
async function createAlertRule(payload) {
  const {
    source,
    alert_type,
    severity,
    name = null,
    dimension_key = null,
    target_type = null,
    target_id = null,
    condition_type = null,
    condition_config = null,
    message_suffix = null,
    enabled = true,
  } = payload;

  const resolvedDimensionKey =
    dimension_key ||
    deriveRuleDimensionKey({ alert_type, condition_type, condition_config });

  const persisted = resolvePersistedTemplateFields(payload);

  const query = `
    INSERT INTO alert_rules (
      source,
      alert_type,
      severity,
      name,
      dimension_key,
      target_type,
      target_id,
      condition_type,
      condition_config,
      message_template_key,
      message_template_custom,
      message_template,
      message_suffix,
      enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
    RETURNING *
  `;

  const result = await db.query(query, [
    source,
    alert_type,
    severity,
    name,
    resolvedDimensionKey,
    target_type,
    target_id,
    condition_type,
    condition_config ? JSON.stringify(condition_config) : null,
    persisted.message_template_key,
    persisted.message_template_custom,
    persisted.message_template,
    message_suffix != null ? String(message_suffix) : null,
    enabled,
  ]);

  const rule = result?.[0] || null;
  if (!rule) {
    throwApiError(C.ALERT_RULE_CREATE_FAILED, "建立警報規則失敗", {
      statusCode: 500,
    });
  }

  if (rule.alert_type === "threshold") {
    clearThresholdRulesCache(rule.source);
  }

  return rule;
}

/**
 * 更新警報規則
 * @param {number} id
 * @param {Object} updates
 * @returns {Promise<Object>} 更新後規則
 */
async function updateAlertRule(id, updates) {
  const existingResult = await db.query(
    "SELECT * FROM alert_rules WHERE id = ? LIMIT 1",
    [id],
  );
  const existingRule = existingResult?.[0] || null;
  if (!existingRule) {
    throwApiError(C.ALERT_RULE_NOT_FOUND, "找不到指定的規則");
  }

  const fields = [];
  const params = [];

  const nextRule = {
    ...existingRule,
    ...updates,
    condition_config:
      updates.condition_config !== undefined
        ? updates.condition_config
        : existingRule.condition_config,
  };

  const effectiveUpdates = { ...updates };
  if (!Boolean(nextRule.message_template_custom)) {
    const persisted = resolvePersistedTemplateFields({
      ...nextRule,
      message_template_custom: false,
    });
    Object.assign(effectiveUpdates, {
      message_template_key: persisted.message_template_key,
      message_template_custom: persisted.message_template_custom,
      message_template: persisted.message_template,
    });
  }

  if (effectiveUpdates.source !== undefined) {
    fields.push("source = ?");
    params.push(effectiveUpdates.source);
  }
  if (effectiveUpdates.alert_type !== undefined) {
    fields.push("alert_type = ?");
    params.push(effectiveUpdates.alert_type);
  }
  if (effectiveUpdates.severity !== undefined) {
    fields.push("severity = ?");
    params.push(effectiveUpdates.severity);
  }
  if (effectiveUpdates.name !== undefined) {
    fields.push("name = ?");
    params.push(effectiveUpdates.name);
  }
  if (effectiveUpdates.dimension_key !== undefined) {
    fields.push("dimension_key = ?");
    params.push(effectiveUpdates.dimension_key);
  }
  if (effectiveUpdates.target_type !== undefined) {
    fields.push("target_type = ?");
    params.push(effectiveUpdates.target_type);
  }
  if (effectiveUpdates.target_id !== undefined) {
    fields.push("target_id = ?");
    params.push(effectiveUpdates.target_id);
  }
  if (effectiveUpdates.condition_type !== undefined) {
    fields.push("condition_type = ?");
    params.push(effectiveUpdates.condition_type);
  }
  if (effectiveUpdates.condition_config !== undefined) {
    fields.push("condition_config = ?::jsonb");
    params.push(
      effectiveUpdates.condition_config === null
        ? null
        : JSON.stringify(effectiveUpdates.condition_config),
    );
  }
  if (effectiveUpdates.message_template !== undefined) {
    fields.push("message_template = ?");
    params.push(effectiveUpdates.message_template);
  }
  if (effectiveUpdates.message_template_key !== undefined) {
    fields.push("message_template_key = ?");
    params.push(effectiveUpdates.message_template_key);
  }
  if (effectiveUpdates.message_template_custom !== undefined) {
    fields.push("message_template_custom = ?");
    params.push(effectiveUpdates.message_template_custom);
  }
  if (effectiveUpdates.message_suffix !== undefined) {
    fields.push("message_suffix = ?");
    params.push(
      effectiveUpdates.message_suffix === null
        ? null
        : String(effectiveUpdates.message_suffix),
    );
  }
  if (effectiveUpdates.enabled !== undefined) {
    fields.push("enabled = ?");
    params.push(effectiveUpdates.enabled);
  }

  // UI 移除 dimension_key 後：若呼叫端未提供 dimension_key，確保規則仍有可重現的維度鍵
  if (updates.dimension_key === undefined) {
    const resolvedDimensionKey =
      existingRule.dimension_key ||
      deriveRuleDimensionKey({
        alert_type: nextRule.alert_type,
        condition_type: nextRule.condition_type,
        condition_config: nextRule.condition_config,
      });
    fields.push("dimension_key = ?");
    params.push(resolvedDimensionKey);
  }

  if (fields.length === 0) {
    return existingRule;
  }

  fields.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);

  const query = `
    UPDATE alert_rules
    SET ${fields.join(", ")}
    WHERE id = ?
    RETURNING *
  `;
  const result = await db.query(query, params);
  const updatedRule = result?.[0] || null;
  if (!updatedRule) {
    throwApiError(C.ALERT_RULE_UPDATE_FAILED, "更新警報規則失敗", {
      statusCode: 500,
    });
  }

  const shouldClearThresholdCache =
    existingRule.alert_type === "threshold" ||
    updatedRule.alert_type === "threshold";
  if (shouldClearThresholdCache) {
    clearThresholdRulesCache(existingRule.source);
    if (updatedRule.source !== existingRule.source) {
      clearThresholdRulesCache(updatedRule.source);
    }
  }

  return updatedRule;
}

/**
 * 刪除警報規則
 * @param {number} id
 * @returns {Promise<Object>} 刪除前的規則
 */
async function deleteAlertRule(id) {
  const result = await db.query(
    "DELETE FROM alert_rules WHERE id = ? RETURNING *",
    [id],
  );
  const deletedRule = result?.[0] || null;
  if (!deletedRule) {
    throwApiError(C.ALERT_RULE_NOT_FOUND, "找不到指定的規則");
  }

  if (deletedRule.alert_type === "threshold") {
    clearThresholdRulesCache(deletedRule.source);
  }

  return deletedRule;
}

/**
 * 評估閾值條件
 * @param {Object} config - 條件配置 { parameter, operator, value, unit }
 * @param {number} value - 當前數值
 * @returns {boolean} 是否符合條件
 */
function evaluateThreshold(config, value) {
  if (value === null || value === undefined) {
    return false;
  }

  const operator = config.operator;
  const threshold = config.value;

  if (typeof threshold !== "number" || typeof value !== "number") {
    return false;
  }

  switch (operator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    default:
      ruleLogger.warn("不支援的運算符", {
        operator,
        module: "alertRuleService",
      });
      return false;
  }
}

/**
 * 格式化訊息模板
 * @param {string} template - 訊息模板
 * @param {Object} variables - 變數對象
 * @returns {string} 格式化後的訊息
 */
function formatMessage(template, variables) {
  if (!template) {
    return "";
  }

  let message = template;

  // 替換所有變數 {variable_name}
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{${key}\\}`, "g");
    message = message.replace(regex, String(value));
  }

  return message;
}

/**
 * 取得參數顯示名稱
 * @param {string} parameter - 參數代碼
 * @returns {string} 顯示名稱
 */
function getParameterDisplayName(parameter) {
  return getCatalogParameterDisplayName(parameter);
}

/**
 * 按參數分組規則
 * @param {Array} rules - 規則列表
 * @returns {Map<string, Array>} 按參數分組的規則
 */
function groupRulesByParameter(rules) {
  const grouped = new Map();

  for (const rule of rules) {
    const parameter = rule.condition_config?.parameter;
    if (!parameter) continue;

    if (!grouped.has(parameter)) {
      grouped.set(parameter, []);
    }
    grouped.get(parameter).push(rule);
  }

  // 對每個參數的規則按嚴重程度排序
  for (const [parameter, paramRules] of grouped) {
    paramRules.sort((a, b) => {
      const orderA = SEVERITY_ORDER[a.severity] || 999;
      const orderB = SEVERITY_ORDER[b.severity] || 999;
      return orderA - orderB;
    });
  }

  return grouped;
}

/**
 * 匹配規則（通用函數）
 * 優先級：指定來源規則 > 全域規則
 * @param {Array} rules - 規則列表
 * @param {string} conditionType - 條件類型（用於過濾）
 * @param {number} sourceId - 來源 ID（用於匹配指定來源規則）
 * @returns {Object|null} 匹配到的規則，如果沒有則返回 null
 */
function matchRule(rules, conditionType, sourceId) {
  if (!rules || rules.length === 0) {
    return null;
  }

  // 過濾出指定條件類型的規則
  const candidateRules = rules.filter(
    (r) => r.condition_type === conditionType,
  );

  if (candidateRules.length === 0) {
    return null;
  }

  // 優先級匹配：指定來源規則 > 全域規則
  // 1. 先找指定 source_id 的規則（確保類型匹配）
  const specificRule = candidateRules.find(
    (r) =>
      r.condition_config?.source_id !== undefined &&
      Number(r.condition_config.source_id) === Number(sourceId),
  );

  if (specificRule) {
    return specificRule;
  }

  // 2. 再找沒有指定 source_id 的全域規則
  const globalRule = candidateRules.find(
    (r) => !r.condition_config || r.condition_config.source_id === undefined,
  );

  return globalRule || null;
}

/**
 * 查詢所有啟用的 DI/DO 規則（供泛用 diDoMonitor 使用）
 * @returns {Promise<Array>}
 */
async function getEnabledDiDoRules() {
  try {
    const rows = await db.query(
      `SELECT * FROM alert_rules
       WHERE alert_type IN ('di', 'do')
         AND condition_type = 'bit_state'
         AND enabled = TRUE
       ORDER BY source, id`,
    );
    return rows || [];
  } catch (error) {
    ruleLogger.error("查詢 DI/DO 規則失敗", {
      error: error?.message || String(error),
      module: "alertRuleService",
    });
    return [];
  }
}

/**
 * 查詢所有來源的規則（預設只回傳 enabled=true）
 * 目的：支援後台列表「全部系統」一次載入，避免前端 source N 次請求。
 * @param {boolean} enabled - 是否只查詢啟用的規則（預設 true）
 * @returns {Promise<Array>}
 */
async function getAllRules(enabled = true) {
  try {
    let query = `
      SELECT * FROM alert_rules
      WHERE 1=1
    `;
    const params = [];
    if (enabled) {
      query += " AND enabled = TRUE";
    }
    query +=
      " ORDER BY source ASC, CASE severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 WHEN 'warning' THEN 3 END, id DESC";
    const result = await db.query(query, params);
    return result || [];
  } catch (error) {
    ruleLogger.error("查詢所有來源規則失敗", {
      error: error?.message || String(error),
      module: "alertRuleService",
    });
    return [];
  }
}

module.exports = {
  getAlertRules,
  getThresholdRules,
  getErrorCountRule,
  getEnabledDiDoRules,
  getAllRulesForSource,
  getAllRules,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  deriveRuleDimensionKey,
  evaluateThreshold,
  formatMessage,
  getParameterDisplayName,
  getThresholdOperatorDisplayLabel,
  groupRulesByParameter,
  matchRule,
  clearThresholdRulesCache,
  SEVERITY_ORDER,
  renderRuleMessage,
  previewRuleMessage,
  MESSAGE_TEMPLATE_KEYS,
  inferDefaultTemplateKey,
};
