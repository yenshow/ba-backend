/**
 * 設備記錄配置與數值轉換（供環境監測等系統使用）
 * 從 deviceDataLogger 萃取，僅保留配置查詢與轉換邏輯
 */

const db = require("../../database/db");
const { parseConfig } = require("../../utils/deviceHelpers");
const logger = require("../../utils/logger");
const { getDeviceTypeName } = require("../../constants/deviceTypes");

const loggingCfgLogger = logger.createLogger("deviceLoggingConfig");

const configCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function _buildLoggingValuesFromSensorParameters(sensorParameters, defaultRegisterType) {
  if (!sensorParameters || !Array.isArray(sensorParameters)) return [];
  const registerType = defaultRegisterType || "holding";
  const values = [];
  for (const param of sensorParameters) {
    const addr = param.modbusConfig?.address;
    if (addr === undefined || addr === null) continue;
    const transform = param.modbusConfig?.transform;
    let formula = null;
    if (transform && String(transform).trim()) {
      const t = String(transform).trim();
      if (/^[\+\-\*\/]/.test(t)) {
        formula = t.startsWith("-") ? `value - ${t.substring(1).trim()}` : `value ${t}`;
      } else if (/^-?\d+(\.\d+)?$/.test(t)) {
        formula = `value - ${t}`;
      } else {
        formula = t.replace(/value/gi, "value");
      }
    }
    const dataType = param.modbusConfig?.dataType || "uint16";
    let length = Number(param.modbusConfig?.length);
    if (!Number.isFinite(length) || length < 1) {
      length = dataType === "uint16" ? 1 : 2;
    }
    values.push({
      name: param.type,
      address: Number(addr),
      register_type: registerType,
      length,
      dataType,
      enabled: true,
      conversion: formula ? { formula } : undefined,
    });
  }
  return values;
}

async function getDeviceLoggingConfig(deviceId) {
  if (configCache.has(deviceId)) {
    return configCache.get(deviceId);
  }

  try {
    const rows = await db.query(
      `SELECT d.config, dm.config as model_config, d.type_code as type_code
       FROM devices d
       LEFT JOIN device_models dm ON d.model_id = dm.id
       WHERE d.id = $1`,
      [deviceId]
    );

    if (!rows || rows.length === 0) {
      return { enabled: false, interval: 60, values: [] };
    }

    const deviceConfig = parseConfig(rows[0].config);
    const modelConfig = parseConfig(rows[0].model_config);
    const typeCode = rows[0].type_code;

    let enabled = deviceConfig?.logging?.enabled ?? modelConfig?.logging?.enabled;
    let values = deviceConfig?.logging?.values ?? modelConfig?.logging?.values ?? [];

    if (typeCode === "sensor") {
      if (enabled === undefined || enabled === null) enabled = true;
      if (!values || values.length === 0) {
        const sensorParams = modelConfig?.sensorParameters ?? deviceConfig?.sensorParameters;
        const defaultRegisterType = modelConfig?.registerType ?? deviceConfig?.registerType ?? "holding";
        values = _buildLoggingValuesFromSensorParameters(sensorParams, defaultRegisterType);
      }
    } else if (enabled === undefined || enabled === null) {
      enabled = false;
    }

    const loggingConfig = {
      enabled: Boolean(enabled),
      interval: deviceConfig?.logging?.interval ?? modelConfig?.logging?.interval ?? 60,
      values: Array.isArray(values) ? values : [],
    };

    configCache.set(deviceId, loggingConfig);
    setTimeout(() => configCache.delete(deviceId), CACHE_TTL_MS);
    return loggingConfig;
  } catch (error) {
    loggingCfgLogger.error("取得設備配置失敗", {
      deviceId,
      error: error?.message || String(error),
      module: "deviceLoggingConfig",
    });
    return { enabled: false, interval: 60, values: [] };
  }
}

/**
 * 將 Modbus 暫存器陣列解成數值（uint16 / uint32 BE|LE）
 * @param {number|number[]} raw
 * @param {string} [dataType]
 */
function decodeRegisterValue(raw, dataType = "uint16") {
  if (!Array.isArray(raw)) {
    return Number(raw);
  }
  if (raw.length === 0) return null;
  if (dataType === "uint32_be" && raw.length >= 2) {
    return ((Number(raw[0]) & 0xffff) << 16) + (Number(raw[1]) & 0xffff);
  }
  if (dataType === "uint32_le" && raw.length >= 2) {
    return ((Number(raw[1]) & 0xffff) << 16) + (Number(raw[0]) & 0xffff);
  }
  return Number(raw[0]);
}

function applyConversion(rawValue, conversion, dataType = "uint16") {
  let value = decodeRegisterValue(rawValue, dataType);
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return rawValue;
  }
  if (!conversion) return value;

  if (conversion.scale !== undefined) {
    value = value * conversion.scale;
  }
  if (conversion.offset !== undefined) {
    value = value + conversion.offset;
  }

  if (conversion.formula) {
    try {
      const formula = conversion.formula.replace(/value/g, String(value));
      value = new Function("return " + formula)();
    } catch (error) {
      loggingCfgLogger.warn("公式轉換失敗（回退原值）", {
        formula: conversion.formula,
        error: error?.message || String(error),
        module: "deviceLoggingConfig",
      });
      return value;
    }
  }

  return value;
}

module.exports = {
  getDeviceLoggingConfig,
  applyConversion,
  decodeRegisterValue,
};
