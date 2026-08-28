/**
 * 對接／轉存匯出：列舉值中文顯示（對齊前端 alertUtils／operational／地點用語）
 * 人名、地點、設備名、JSON、路徑不經此轉換。
 */

const {
  getParameterDisplayName,
} = require("../../constants/environmentParameterCatalog");

const ALERT_STATUS_LABELS = {
  active: "未解決",
  resolved: "已解決",
  ignored: "已忽視",
};

const ALERT_SEVERITY_LABELS = {
  warning: "異常",
  error: "錯誤",
  critical: "警報",
};

const ALERT_TYPE_LABELS = {
  offline: "離線",
  error: "錯誤",
  threshold: "閾值",
  di: "DI",
  do: "DO",
};

/** 警報／營運共用：系統來源 */
const SYSTEM_SOURCE_LABELS = {
  device: "設備",
  environment: "環境品質",
  lighting: "照明系統",
  hvac: "空調系統",
  drainage: "排水系統",
  air_circulation: "空氣循環",
  power: "電力系統",
  energy: "能源管理",
  fire: "消防系統",
  smoke_alarm: "煙霧警報",
  emergency_rescue: "緊急求救",
  people_counting: "門禁管理",
  access_control: "門禁管理",
  vehicle_access: "車輛進出",
  elevator: "電梯管理",
  access_security: "門禁保全",
  alert_linkage: "警報連動",
  video_intercom: "組網對講",
  access_security_ring: "語音廣播",
  system: "系統",
};

const OPERATIONAL_KIND_LABELS = {
  control_write: "控制寫入",
  state_change: "狀態變化",
  access: "門禁／人流",
  vehicle: "車輛進出",
  elevator: "電梯管理",
  intercom: "對講",
};

const VEHICLE_DATA_SOURCE_LABELS = {
  isapi_camera: "攝影機",
  yscp: "YSCP",
  access_control: "門禁設備",
};

const DIMENSION_TOKEN_LABELS = {
  ...ALERT_TYPE_LABELS,
  default: "預設",
  ch: "通道",
  load: "負載",
};

function mapLabel(dict, raw) {
  const key = String(raw ?? "").trim();
  if (!key) return "";
  return dict[key] ?? key;
}

function labelAlertStatus(raw) {
  return mapLabel(ALERT_STATUS_LABELS, raw);
}

function labelAlertSeverity(raw) {
  return mapLabel(ALERT_SEVERITY_LABELS, raw);
}

function labelAlertType(raw) {
  return mapLabel(ALERT_TYPE_LABELS, raw);
}

function labelSystemSource(raw) {
  return mapLabel(SYSTEM_SOURCE_LABELS, raw);
}

function labelOperationalKind(raw) {
  return mapLabel(OPERATIONAL_KIND_LABELS, raw);
}

function labelVehicleDataSource(raw) {
  return mapLabel(VEHICLE_DATA_SOURCE_LABELS, raw);
}

/**
 * 維度鍵中文化（保留結構分隔）
 * 例：threshold:pm25 → 閾值:PM2.5；di:ch:0 → DI:通道:0；load-di-3 → 負載-DI-3
 */
function labelDimensionKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";

  const translateToken = (tok) => {
    const t = String(tok ?? "").trim();
    if (!t) return "";
    if (DIMENSION_TOKEN_LABELS[t]) return DIMENSION_TOKEN_LABELS[t];
    const loadDi = /^load-di-(\d+)$/i.exec(t);
    if (loadDi) return `負載-DI-${loadDi[1]}`;
    const paramLabel = getParameterDisplayName(t);
    if (paramLabel && paramLabel !== t) return paramLabel;
    return t;
  };

  if (s.includes(":")) {
    return s.split(":").map(translateToken).join(":");
  }
  return translateToken(s);
}

module.exports = {
  labelAlertStatus,
  labelAlertSeverity,
  labelAlertType,
  labelSystemSource,
  labelOperationalKind,
  labelVehicleDataSource,
  labelDimensionKey,
};
