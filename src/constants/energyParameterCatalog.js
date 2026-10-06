/**
 * 能源表計參數 catalog SSOT
 * - 前端透過 GET /energy/parameters 消費
 * - 型號 sensorParameters.type 可使用本 catalog keys（與環境 catalog 並存）
 */

const CATALOG_VERSION = "2026-10-06";

/** @type {ReadonlyArray<{
 *   key: string;
 *   kind: 'meter';
 *   label: string;
 *   unit: string;
 *   semantics: 'cumulative' | 'instantaneous';
 *   meterKinds: Array<'electricity' | 'water'>;
 *   fractionDigits: number;
 *   sortOrder: number;
 *   group?: string;
 *   requiredForMeterKind?: 'electricity' | 'water';
 * }>} */
const ENERGY_PARAMETERS = [
  {
    key: "active_energy",
    kind: "meter",
    label: "輸入有效電能",
    unit: "kWh",
    semantics: "cumulative",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 10,
    group: "Energy",
    requiredForMeterKind: "electricity",
  },
  {
    key: "total_energy",
    kind: "meter",
    label: "總有效電能",
    unit: "kWh",
    semantics: "cumulative",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 11,
    group: "Energy",
  },
  {
    key: "water_volume",
    kind: "meter",
    label: "累積水量",
    unit: "m³",
    semantics: "cumulative",
    meterKinds: ["water"],
    fractionDigits: 3,
    sortOrder: 20,
    group: "Energy",
    requiredForMeterKind: "water",
  },
  {
    key: "active_power",
    kind: "meter",
    label: "總有效功率",
    unit: "kW",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 2,
    sortOrder: 30,
    group: "Active_Power",
  },
  {
    key: "demand",
    kind: "meter",
    label: "需量",
    unit: "kW",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 2,
    sortOrder: 40,
    group: "Demand",
  },
  // —— Voltage ——
  {
    key: "voltage_v1",
    kind: "meter",
    label: "V1 相電壓",
    unit: "V",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 2,
    sortOrder: 100,
    group: "Voltage",
  },
  {
    key: "voltage_v2",
    kind: "meter",
    label: "V2 相電壓",
    unit: "V",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 2,
    sortOrder: 101,
    group: "Voltage",
  },
  {
    key: "voltage_v3",
    kind: "meter",
    label: "V3 相電壓",
    unit: "V",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 2,
    sortOrder: 102,
    group: "Voltage",
  },
  {
    key: "voltage_avg",
    kind: "meter",
    label: "平均相電壓 VLN",
    unit: "V",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 2,
    sortOrder: 103,
    group: "Voltage",
  },
  // —— Current ——
  {
    key: "current_i1",
    kind: "meter",
    label: "I1 電流",
    unit: "A",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 110,
    group: "Current",
  },
  {
    key: "current_i2",
    kind: "meter",
    label: "I2 電流",
    unit: "A",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 111,
    group: "Current",
  },
  {
    key: "current_i3",
    kind: "meter",
    label: "I3 電流",
    unit: "A",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 112,
    group: "Current",
  },
  {
    key: "current_avg",
    kind: "meter",
    label: "平均電流",
    unit: "A",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 113,
    group: "Current",
  },
  // —— Power Factor ——
  {
    key: "pf_1",
    kind: "meter",
    label: "PF1 功率因數",
    unit: "--",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 120,
    group: "Power_Factor",
  },
  {
    key: "pf_2",
    kind: "meter",
    label: "PF2 功率因數",
    unit: "--",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 121,
    group: "Power_Factor",
  },
  {
    key: "pf_3",
    kind: "meter",
    label: "PF3 功率因數",
    unit: "--",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 122,
    group: "Power_Factor",
  },
  {
    key: "pf_avg",
    kind: "meter",
    label: "平均功率因數",
    unit: "--",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 123,
    group: "Power_Factor",
  },
  // —— Active Power phases ——
  {
    key: "active_power_p1",
    kind: "meter",
    label: "P1 有效功率",
    unit: "kW",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 130,
    group: "Active_Power",
  },
  {
    key: "active_power_p2",
    kind: "meter",
    label: "P2 有效功率",
    unit: "kW",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 131,
    group: "Active_Power",
  },
  {
    key: "active_power_p3",
    kind: "meter",
    label: "P3 有效功率",
    unit: "kW",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 132,
    group: "Active_Power",
  },
  // —— Item ——
  {
    key: "frequency",
    kind: "meter",
    label: "頻率",
    unit: "Hz",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 140,
    group: "Item",
  },
  {
    key: "load_type",
    kind: "meter",
    label: "負載特性",
    unit: "--",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 0,
    sortOrder: 141,
    group: "Item",
  },
  {
    key: "run_hour",
    kind: "meter",
    label: "操作時間",
    unit: "min",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 0,
    sortOrder: 142,
    group: "Item",
  },
  {
    key: "co2",
    kind: "meter",
    label: "CO2 排放",
    unit: "Kg",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 3,
    sortOrder: 143,
    group: "Item",
  },
  {
    key: "cost",
    kind: "meter",
    label: "電費金額",
    unit: "--",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 2,
    sortOrder: 144,
    group: "Item",
  },
];

const ENERGY_PARAMETER_KEY_SET = new Set(ENERGY_PARAMETERS.map((p) => p.key));

const METER_KINDS = ["electricity", "water"];
const MODBUS_DATA_TYPES = [
  "uint16",
  "uint32_be",
  "uint32_le",
  "float32_be",
  "float32_le",
  "float64_be",
  "float64_le",
];

/** @param {string} dataType */
function defaultLengthForDataType(dataType) {
  const t = String(dataType || "uint16");
  if (t === "uint16") return 1;
  if (t === "float64_be" || t === "float64_le") return 4;
  return 2; // uint32_* / float32_*
}

function isValidEnergyParameterKey(key) {
  return ENERGY_PARAMETER_KEY_SET.has(String(key || ""));
}

function listEnergyParameterKeys() {
  return ENERGY_PARAMETERS.map((p) => p.key);
}

function getEnergyParameter(key) {
  return ENERGY_PARAMETERS.find((p) => p.key === key) || null;
}

function getEnergyParametersPayload() {
  const {
    getEnergyUsageSystemsPayload,
  } = require("./energyUsageSystemCatalog");
  return {
    version: CATALOG_VERSION,
    parameters: ENERGY_PARAMETERS,
    meterKinds: METER_KINDS,
    dataTypes: MODBUS_DATA_TYPES,
    usageSystems: getEnergyUsageSystemsPayload(),
  };
}

module.exports = {
  CATALOG_VERSION,
  ENERGY_PARAMETERS,
  METER_KINDS,
  MODBUS_DATA_TYPES,
  defaultLengthForDataType,
  isValidEnergyParameterKey,
  listEnergyParameterKeys,
  getEnergyParameter,
  getEnergyParametersPayload,
};
