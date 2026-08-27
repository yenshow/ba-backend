/**
 * 警報顯示文案 SSOT（純函式，無 DB）
 * message 只給人看；業務判斷用 alert_type + condition_config + dimension_key。
 */
const { getAlertSourceLabel } = require("../../access/catalog");

/** 與前端約定：規則訊息以 canonical 模板 + 變數渲染 */
const MESSAGE_TEMPLATE_KEYS = {
  THRESHOLD_V1: "rule.threshold.v1",
  OFFLINE_V1: "rule.offline.v1",
  DI_V1: "rule.di.v1",
  DO_V1: "rule.do.v1",
  ENERGY_CONTRACT_STAGE_V1: "rule.energy.contract_stage.v1",
  ENERGY_METER_STALE_V1: "rule.energy.meter_stale.v1",
  ENERGY_READING_JUMP_V1: "rule.energy.reading_jump.v1",
  CUSTOM: "custom",
};

const ALLOWED_MESSAGE_TEMPLATE_KEYS = Object.values(MESSAGE_TEMPLATE_KEYS).filter(
  (k) => k !== MESSAGE_TEMPLATE_KEYS.CUSTOM,
);

/** Canonical 模板皆以 `{location_label}` 為唯一來源前綴占位 */
const CANONICAL_TEMPLATES = {
  [MESSAGE_TEMPLATE_KEYS.THRESHOLD_V1]:
    "{location_label} {parameter_name} {operator} {threshold}{unit}（當前 {current_value}{unit}）",
  [MESSAGE_TEMPLATE_KEYS.OFFLINE_V1]:
    "{location_label} 連續 {error_count} 次無法連接",
  [MESSAGE_TEMPLATE_KEYS.DI_V1]:
    "{location_label} DI {di_address} 觸發",
  [MESSAGE_TEMPLATE_KEYS.DO_V1]:
    "{location_label} DO {do_address} 觸發",
  [MESSAGE_TEMPLATE_KEYS.ENERGY_CONTRACT_STAGE_V1]:
    "契約 {level} 級：即時功率／需量 {demand_kw} kW 已達契約容量 {contract_kw} kW 的 {threshold_pct}%",
  [MESSAGE_TEMPLATE_KEYS.ENERGY_METER_STALE_V1]:
    "{location_label}：通訊逾時，最近 {stale_minutes} 分鐘無讀數",
  [MESSAGE_TEMPLATE_KEYS.ENERGY_READING_JUMP_V1]:
    "{location_label}：讀數跳動異常（單次 +{delta_kwh} kWh）",
};

function inferEnergyTemplateKey(conditionType) {
  const ct = String(conditionType || "").trim();
  if (ct === "energy_contract_stage") {
    return MESSAGE_TEMPLATE_KEYS.ENERGY_CONTRACT_STAGE_V1;
  }
  if (ct === "energy_meter_stale") {
    return MESSAGE_TEMPLATE_KEYS.ENERGY_METER_STALE_V1;
  }
  if (ct === "energy_reading_jump") {
    return MESSAGE_TEMPLATE_KEYS.ENERGY_READING_JUMP_V1;
  }
  return null;
}

function inferDefaultTemplateKey(alertType, conditionType = null) {
  const energyKey = inferEnergyTemplateKey(conditionType);
  if (energyKey) return energyKey;
  if (alertType === "threshold") return MESSAGE_TEMPLATE_KEYS.THRESHOLD_V1;
  if (alertType === "offline") return MESSAGE_TEMPLATE_KEYS.OFFLINE_V1;
  if (alertType === "di") return MESSAGE_TEMPLATE_KEYS.DI_V1;
  if (alertType === "do") return MESSAGE_TEMPLATE_KEYS.DO_V1;
  return null;
}

function getCanonicalTemplateString(key) {
  return CANONICAL_TEMPLATES[key] || "";
}

/** 訊息模板 {operator}：僅「超過／低於」 */
function getThresholdOperatorDisplayLabel(operator) {
  const op = String(operator ?? "").trim();
  if (op === ">" || op === ">=") return "超過";
  if (op === "<" || op === "<=") return "低於";
  return "";
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

function formatLocationPrefix(locationLabel) {
  const label = locationLabel != null ? String(locationLabel).trim() : "";
  return label ? `${label}：` : "";
}

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

function resolveRuleTemplate(rule) {
  const key = rule?.message_template_key;
  if (key && CANONICAL_TEMPLATES[key]) {
    return CANONICAL_TEMPLATES[key];
  }
  if (rule?.message_template) {
    return rule.message_template;
  }
  const energyKey = inferEnergyTemplateKey(rule?.condition_type);
  if (energyKey) return CANONICAL_TEMPLATES[energyKey] || "";
  const fb = inferDefaultTemplateKey(rule?.alert_type, rule?.condition_type);
  return fb ? CANONICAL_TEMPLATES[fb] || "" : "";
}

function resolvePersistedTemplateFields(payload) {
  const alertType = payload.alert_type;
  const conditionType = payload.condition_type;
  let key =
    inferDefaultTemplateKey(alertType, conditionType) ||
    MESSAGE_TEMPLATE_KEYS.THRESHOLD_V1;
  if (payload.message_template_key && CANONICAL_TEMPLATES[payload.message_template_key]) {
    key = payload.message_template_key;
  }
  if (!CANONICAL_TEMPLATES[key]) {
    key = MESSAGE_TEMPLATE_KEYS.THRESHOLD_V1;
  }
  return {
    message_template_key: key,
    message_template_custom: false,
    message_template: key ? getCanonicalTemplateString(key) : "",
  };
}

function formatMessage(template, variables) {
  if (!template) return "";
  let message = template;
  for (const [key, value] of Object.entries(variables || {})) {
    const regex = new RegExp(`\\{${key}\\}`, "g");
    message = message.replace(regex, String(value ?? ""));
  }
  return message;
}

function parseBitAddress(bitKey) {
  const m = String(bitKey || "").match(/^(di|do):(\d+)$/i);
  if (!m) return { kind: null, address: null };
  return { kind: m[1].toLowerCase(), address: m[2] };
}

function resolveSourceLabel(source) {
  return getAlertSourceLabel(source) || String(source || "未知");
}

function formatDeviceFallbackName(deviceId, deviceName) {
  const name = deviceName != null ? String(deviceName).trim() : "";
  if (name) return name;
  if (deviceId != null && Number.isFinite(Number(deviceId))) {
    return `設備 #${deviceId}`;
  }
  return "設備";
}

/** offline / error_count 規則渲染失敗兜底 */
function summaryOfflineFallback({
  locationLabel = null,
  sourceLabel = null,
  sourceDisplayName = null,
  errorCount,
}) {
  const prefix =
    String(locationLabel || "").trim() ||
    String(sourceDisplayName || "").trim() ||
    String(sourceLabel || "").trim() ||
    "來源";
  const count = Math.max(1, Number(errorCount) || 1);
  return `${prefix} 連續 ${count} 次無法連接`;
}

/** DI/DO bit 觸發兜底（diDoMonitor / systemAlertHelper） */
function summaryBitTriggerFallback({
  alertType,
  address,
  locationLabel = null,
  sourceLabel = null,
}) {
  const key = String(alertType || "").trim().toLowerCase();
  const kind = key === "do" ? "DO" : key === "di" ? "DI" : "點位";
  const addr = address != null ? String(address) : "?";
  const place = formatLocationPrefix(locationLabel);
  if (place) return `${place}${kind} ${addr} 觸發`;
  if (sourceLabel) return `${sourceLabel}：${kind} ${addr} 觸發`;
  return `${kind} ${addr} 觸發`;
}

/** recordRuleBitStateAlarm 兜底 */
function summaryRuleBitStateFallback({ source, bitKey, locationLabel = null }) {
  const parsed = parseBitAddress(bitKey);
  return summaryBitTriggerFallback({
    alertType: parsed.kind || "di",
    address: parsed.address,
    locationLabel,
    sourceLabel: resolveSourceLabel(source),
  });
}

/** 手動觸發警報兜底 */
function summaryManualAlarmFallback({ sourceLabel }) {
  const label = String(sourceLabel || "").trim() || "系統";
  return `${label} 手動觸發警報`;
}

function summaryEnergyContractStage({
  level,
  demandKw,
  contractKw,
  thresholdPct,
}) {
  const demand = Number(demandKw);
  const contract = Number(contractKw);
  const pct = Number(thresholdPct);
  return formatMessage(CANONICAL_TEMPLATES[MESSAGE_TEMPLATE_KEYS.ENERGY_CONTRACT_STAGE_V1], {
    level: String(level ?? ""),
    demand_kw: Number.isFinite(demand) ? demand.toFixed(1) : "—",
    contract_kw: Number.isFinite(contract) ? contract.toFixed(1) : "—",
    threshold_pct: Number.isFinite(pct) ? String(Math.round(pct)) : "—",
  });
}

function summaryEnergyMeterStale({ deviceName, deviceId, staleMinutes }) {
  const label = formatDeviceFallbackName(deviceId, deviceName);
  const mins = Math.max(1, Number(staleMinutes) || 15);
  return formatMessage(CANONICAL_TEMPLATES[MESSAGE_TEMPLATE_KEYS.ENERGY_METER_STALE_V1], {
    location_label: label,
    stale_minutes: String(mins),
  });
}

function summaryEnergyReadingJump({ deviceName, deviceId, deltaKwh }) {
  const label = formatDeviceFallbackName(deviceId, deviceName);
  const delta = Number(deltaKwh);
  return formatMessage(CANONICAL_TEMPLATES[MESSAGE_TEMPLATE_KEYS.ENERGY_READING_JUMP_V1], {
    location_label: label,
    delta_kwh: Number.isFinite(delta) ? delta.toFixed(1) : "—",
  });
}

module.exports = {
  MESSAGE_TEMPLATE_KEYS,
  ALLOWED_MESSAGE_TEMPLATE_KEYS,
  inferDefaultTemplateKey,
  getCanonicalTemplateString,
  getThresholdOperatorDisplayLabel,
  formatZoneDashLocation,
  normalizeAlertRuleTemplate,
  resolveRuleTemplate,
  resolvePersistedTemplateFields,
  formatMessage,
  resolveSourceLabel,
  formatDeviceFallbackName,
  summaryOfflineFallback,
  summaryBitTriggerFallback,
  summaryRuleBitStateFallback,
  summaryManualAlarmFallback,
  summaryEnergyContractStage,
  summaryEnergyMeterStale,
  summaryEnergyReadingJump,
};
