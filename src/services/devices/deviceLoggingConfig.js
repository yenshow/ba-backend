/**
 * 設備記錄配置與數值轉換（供環境監測等系統使用）
 * 從 deviceDataLogger 萃取，僅保留配置查詢與轉換邏輯
 */

const db = require("../../database/db");
const { parseConfig } = require("../../utils/deviceHelpers");

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
    values.push({
      name: param.type,
      address: Number(addr),
      register_type: registerType,
      length: 1,
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
      `SELECT d.config, dm.config as model_config, dt.code as type_code
       FROM devices d
       LEFT JOIN device_models dm ON d.model_id = dm.id
       LEFT JOIN device_types dt ON d.type_id = dt.id
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
    console.error(`[deviceLoggingConfig] 取得設備配置失敗 (deviceId: ${deviceId}):`, error);
    return { enabled: false, interval: 60, values: [] };
  }
}

function applyConversion(rawValue, conversion) {
  if (!conversion) return rawValue;

  let value = rawValue;

  if (conversion.scale !== undefined) {
    value = value * conversion.scale;
  }
  if (conversion.offset !== undefined) {
    value = value + conversion.offset;
  }

  if (conversion.formula) {
    try {
      const formula = conversion.formula.replace(/value/g, value);
      value = new Function("return " + formula)();
    } catch (error) {
      console.error(`[deviceLoggingConfig] 公式轉換失敗 (formula: ${conversion.formula}):`, error);
      return rawValue;
    }
  }

  return value;
}

module.exports = {
  getDeviceLoggingConfig,
  applyConversion,
};
