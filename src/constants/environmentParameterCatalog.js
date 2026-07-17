/**
 * 環境感測參數 catalog SSOT
 * - 9 個 raw sensor keys + 2 個 derived（aqi / heatIndex）
 * - 前端透過 GET /environment/parameters 消費；後端驗證／訊息／備份皆 import 本檔
 */

const CATALOG_VERSION = "2026-07-17";

const THRESHOLD_OPERATORS = [
  { op: ">", label: "超過" },
  { op: ">=", label: "超過" },
  { op: "<", label: "低於" },
  { op: "<=", label: "低於" },
];

/** @type {ReadonlyArray<{
 *   key: string;
 *   kind: 'sensor' | 'derived';
 *   label: string;
 *   unit: string;
 *   fractionDigits: number;
 *   gaugeMax: number | null;
 *   icon?: string;
 *   sortOrder: number;
 *   capabilities: { deviceModel: boolean; locationToggle: boolean; alertThreshold: boolean };
 *   display?: Record<string, unknown>;
 * }>} */
const ENVIRONMENT_PARAMETERS = [
  {
    key: "pm25",
    kind: "sensor",
    label: "PM2.5",
    unit: "µg/m³",
    fractionDigits: 0,
    gaugeMax: 150,
    icon: "/environment/PM2.5.png",
    sortOrder: 10,
    capabilities: {
      deviceModel: true,
      locationToggle: true,
      alertThreshold: true,
    },
  },
  {
    key: "pm10",
    kind: "sensor",
    label: "PM10",
    unit: "µg/m³",
    fractionDigits: 0,
    gaugeMax: 150,
    icon: "/environment/PM10.png",
    sortOrder: 20,
    capabilities: {
      deviceModel: true,
      locationToggle: true,
      alertThreshold: true,
    },
  },
  {
    key: "tvoc",
    kind: "sensor",
    label: "TVOC",
    unit: "ppm",
    fractionDigits: 1,
    gaugeMax: 10,
    icon: "/environment/TVOC.png",
    sortOrder: 30,
    capabilities: {
      deviceModel: true,
      locationToggle: true,
      alertThreshold: true,
    },
  },
  {
    key: "hcho",
    kind: "sensor",
    label: "HCHO",
    unit: "ppm",
    fractionDigits: 1,
    gaugeMax: 1,
    icon: "/environment/HCHO.png",
    sortOrder: 40,
    capabilities: {
      deviceModel: true,
      locationToggle: true,
      alertThreshold: true,
    },
  },
  {
    key: "humidity",
    kind: "sensor",
    label: "濕度",
    unit: "%",
    fractionDigits: 1,
    gaugeMax: 100,
    icon: "/environment/humidity.png",
    sortOrder: 50,
    capabilities: {
      deviceModel: true,
      locationToggle: true,
      alertThreshold: true,
    },
  },
  {
    key: "temperature",
    kind: "sensor",
    label: "溫度",
    unit: "°C",
    fractionDigits: 1,
    gaugeMax: 50,
    icon: "/environment/temperature.png",
    sortOrder: 60,
    capabilities: {
      deviceModel: true,
      locationToggle: true,
      alertThreshold: true,
    },
  },
  {
    key: "co2",
    kind: "sensor",
    label: "CO2",
    unit: "ppm",
    fractionDigits: 0,
    gaugeMax: 2000,
    icon: "/environment/CO2.png",
    sortOrder: 70,
    capabilities: {
      deviceModel: true,
      locationToggle: true,
      alertThreshold: true,
    },
  },
  {
    key: "noise",
    kind: "sensor",
    label: "噪音值",
    unit: "dB",
    fractionDigits: 0,
    gaugeMax: 100,
    icon: "/environment/noise.png",
    sortOrder: 80,
    capabilities: {
      deviceModel: true,
      locationToggle: true,
      alertThreshold: true,
    },
  },
  {
    key: "wind",
    kind: "sensor",
    label: "風速",
    unit: "m/s",
    fractionDigits: 1,
    gaugeMax: 30,
    icon: "/environment/wind-speed.png",
    sortOrder: 90,
    capabilities: {
      deviceModel: true,
      locationToggle: true,
      alertThreshold: true,
    },
  },
  {
    key: "aqi",
    kind: "derived",
    label: "AQI",
    unit: "",
    fractionDigits: 0,
    gaugeMax: 150,
    sortOrder: 100,
    capabilities: {
      deviceModel: false,
      locationToggle: false,
      alertThreshold: false,
    },
    display: {
      statusBands: [
        { max: 100, status: "normal" },
        { max: 150, status: "warning" },
        { max: null, status: "alarm" },
      ],
    },
  },
  {
    key: "heatIndex",
    kind: "derived",
    label: "熱指數",
    unit: "°C",
    fractionDigits: 1,
    gaugeMax: null,
    sortOrder: 110,
    capabilities: {
      deviceModel: false,
      locationToggle: false,
      alertThreshold: false,
    },
    display: {
      levelBands: [
        { max: 27, level: 1 },
        { max: 32, level: 2 },
        { max: 41, level: 3 },
        { max: 54, level: 4 },
        { max: null, level: 5 },
      ],
      levelUnitLabel: "級",
    },
  },
];

// 以小寫 key 建索引，與 normalizeKey 的查詢一致（如 heatIndex）
const BY_KEY = new Map(
  ENVIRONMENT_PARAMETERS.map((p) => [p.key.toLowerCase(), p]),
);

function normalizeKey(key) {
  if (key == null || key === "") return "";
  return String(key).trim().toLowerCase();
}

function getEnvironmentParameter(key) {
  const k = normalizeKey(key);
  return BY_KEY.get(k) ?? null;
}

function listAllParameters() {
  return ENVIRONMENT_PARAMETERS;
}

function listSensorParameterKeys() {
  return ENVIRONMENT_PARAMETERS.filter((p) => p.kind === "sensor").map(
    (p) => p.key,
  );
}

function listDerivedParameterKeys() {
  return ENVIRONMENT_PARAMETERS.filter((p) => p.kind === "derived").map(
    (p) => p.key,
  );
}

function listAlertThresholdParameterKeys() {
  return ENVIRONMENT_PARAMETERS.filter(
    (p) => p.capabilities.alertThreshold,
  ).map((p) => p.key);
}

function isValidSensorParameterKey(key) {
  const p = getEnvironmentParameter(key);
  return p != null && p.kind === "sensor" && p.capabilities.deviceModel;
}

function isValidAlertThresholdParameterKey(key) {
  const p = getEnvironmentParameter(key);
  return p != null && p.capabilities.alertThreshold;
}

function getParameterDisplayName(parameter) {
  if (parameter == null || parameter === "") return "";
  const p = getEnvironmentParameter(parameter);
  if (p) return p.label;
  return String(parameter).trim().toUpperCase();
}

function getParameterUnit(parameter) {
  const p = getEnvironmentParameter(parameter);
  return p?.unit ?? "";
}

function buildParametersApiPayload() {
  return {
    version: CATALOG_VERSION,
    sensorKeys: listSensorParameterKeys(),
    derivedKeys: listDerivedParameterKeys(),
    parameters: ENVIRONMENT_PARAMETERS.map((p) => ({
      key: p.key,
      kind: p.kind,
      label: p.label,
      unit: p.unit,
      fractionDigits: p.fractionDigits,
      gaugeMax: p.gaugeMax,
      ...(p.icon ? { icon: p.icon } : {}),
      sortOrder: p.sortOrder,
      capabilities: { ...p.capabilities },
      ...(p.display ? { display: p.display } : {}),
    })),
    thresholdOperators: THRESHOLD_OPERATORS.map(({ op, label }) => ({
      op,
      label,
    })),
  };
}

module.exports = {
  CATALOG_VERSION,
  ENVIRONMENT_PARAMETERS,
  THRESHOLD_OPERATORS,
  listAllParameters,
  listSensorParameterKeys,
  listDerivedParameterKeys,
  listAlertThresholdParameterKeys,
  getEnvironmentParameter,
  getParameterDisplayName,
  getParameterUnit,
  isValidSensorParameterKey,
  isValidAlertThresholdParameterKey,
  buildParametersApiPayload,
};
