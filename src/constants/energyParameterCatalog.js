/**
 * 能源表計參數 catalog SSOT
 * - 前端透過 GET /energy/parameters 消費
 * - 型號 sensorParameters.type 可使用本 catalog keys（與環境 catalog 並存）
 */

const CATALOG_VERSION = "2026-08-03";

/** @type {ReadonlyArray<{
 *   key: string;
 *   kind: 'meter';
 *   label: string;
 *   unit: string;
 *   semantics: 'cumulative' | 'instantaneous';
 *   meterKinds: Array<'electricity' | 'water'>;
 *   fractionDigits: number;
 *   sortOrder: number;
 *   requiredForMeterKind?: 'electricity' | 'water';
 * }>} */
const ENERGY_PARAMETERS = [
  {
    key: "active_energy",
    kind: "meter",
    label: "累積電能",
    unit: "kWh",
    semantics: "cumulative",
    meterKinds: ["electricity"],
    fractionDigits: 2,
    sortOrder: 10,
    requiredForMeterKind: "electricity",
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
    requiredForMeterKind: "water",
  },
  {
    key: "active_power",
    kind: "meter",
    label: "即時功率",
    unit: "kW",
    semantics: "instantaneous",
    meterKinds: ["electricity"],
    fractionDigits: 2,
    sortOrder: 30,
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
  },
];

const ENERGY_PARAMETER_KEY_SET = new Set(ENERGY_PARAMETERS.map((p) => p.key));

const METER_KINDS = ["electricity", "water"];
const MODBUS_DATA_TYPES = ["uint16", "uint32_be", "uint32_le"];

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
  isValidEnergyParameterKey,
  listEnergyParameterKeys,
  getEnergyParameter,
  getEnergyParametersPayload,
};
