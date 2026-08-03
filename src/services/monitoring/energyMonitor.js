/**
 * 能源 Monitor：輪詢 include_device_ids 表計 → 寫入 readings → WS → 契約容量告警
 */
const db = require("../../database/db");
const modbusBatchService = require("../devices/modbusBatchService");
const deviceLoggingConfig = require("../devices/deviceLoggingConfig");
const energySettingsService = require("../energy/energySettingsService");
const energyReadingsService = require("../energy/energyReadingsService");
const alertService = require("../alerts/alertService");
const websocketService = require("../websocket/websocketService");
const logger = require("../../utils/logger").createLogger("energyMonitor");
const {
  ENERGY_RAW_WRITE_INTERVAL_MS,
} = require("../../config/realtimeTiming");
const { parseConfig } = require("../../utils/deviceHelpers");
const { isValidEnergyParameterKey } = require("../../constants/energyParameterCatalog");

const lastRawWriteByDevice = new Map();
const CONTRACT_SOURCE_ID = energySettingsService.SETTINGS_ID;
const CONTRACT_DIMENSION = "contract_demand";

async function readMeterValues(enabledValues, deviceConfig) {
  const deviceValues = {};
  const registerTypes = [
    { type: "holding", batchType: "holding" },
    { type: "input", batchType: "input" },
    { type: "coils", batchType: "coil" },
    { type: "discrete", batchType: "discrete" },
  ];

  for (const { type: registerType, batchType } of registerTypes) {
    const group = enabledValues.filter(
      (v) => (v.register_type || "holding") === registerType,
    );
    if (group.length === 0) continue;

    let minAddress = group[0].address;
    let maxAddress = group[0].address + (group[0].length || 1);
    for (const vc of group) {
      const endAddr = vc.address + (vc.length || 1);
      minAddress = Math.min(minAddress, vc.address);
      maxAddress = Math.max(maxAddress, endAddr);
    }
    const readLength = maxAddress - minAddress;
    if (readLength <= 0) continue;

    let modbusData;
    try {
      const results = await modbusBatchService.batchRead([
        {
          host: deviceConfig.host,
          port: deviceConfig.port,
          unitId: deviceConfig.unitId,
          registerType: batchType,
          address: minAddress,
          length: readLength,
        },
      ]);
      const first = results?.[0];
      if (!first || first.ok !== true) {
        throw new Error(first?.error || "Modbus 讀取失敗");
      }
      modbusData = first.data;
    } catch (err) {
      logger.warn("讀取暫存器失敗", {
        error: err.message,
        registerType,
        minAddress,
        readLength,
      });
      continue;
    }

    for (const valueConfig of group) {
      if (!isValidEnergyParameterKey(valueConfig.name)) continue;
      const relativeAddress = valueConfig.address - minAddress;
      const len = valueConfig.length || 1;
      const rawValue =
        Array.isArray(modbusData) &&
        relativeAddress >= 0 &&
        relativeAddress + len <= modbusData.length
          ? len === 1
            ? modbusData[relativeAddress]
            : modbusData.slice(relativeAddress, relativeAddress + len)
          : null;
      if (rawValue === null || rawValue === undefined) continue;
      const converted = deviceLoggingConfig.applyConversion(
        rawValue,
        valueConfig.conversion,
        valueConfig.dataType || "uint16",
      );
      if (typeof converted === "number" && !Number.isNaN(converted)) {
        deviceValues[valueConfig.name] = converted;
      }
    }
  }
  return deviceValues;
}

function buildDeviceConfig(rawConfig) {
  const cfg = parseConfig(rawConfig) || {};
  return {
    host: cfg.ip || cfg.host,
    port: Number(cfg.port) || 502,
    unitId: Number(cfg.unit_id ?? cfg.unitId ?? 1) || 1,
  };
}

async function resolveContractAlertQuietly() {
  try {
    await alertService.resolveAlert(
      CONTRACT_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      alertService.ALERT_SOURCES.ENERGY,
      CONTRACT_DIMENSION,
    );
  } catch (err) {
    const msg = err?.message || String(err);
    if (!msg.includes("未找到可更新的警報")) {
      logger.warn("結案契約告警失敗", { error: msg });
    }
  }
}

/**
 * @param {{ enabled: boolean, demandKw: number|null, contractKw: number, hasSample: boolean }} opts
 * - hasSample=false：缺測，不更新告警狀態（避免誤清）
 * - include 為空或告警關閉：強制結案
 */
async function syncContractDemandAlert({
  enabled,
  demandKw,
  contractKw,
  hasSample,
}) {
  if (!enabled || !(Number(contractKw) > 0)) {
    await resolveContractAlertQuietly();
    return;
  }
  if (!hasSample || !Number.isFinite(Number(demandKw))) {
    return;
  }

  const over = Number(demandKw) >= Number(contractKw);
  if (over) {
    await alertService.createAlert({
      source: alertService.ALERT_SOURCES.ENERGY,
      source_id: CONTRACT_SOURCE_ID,
      alert_type: alertService.ALERT_TYPES.THRESHOLD,
      severity: alertService.SEVERITIES.WARNING,
      dimension_key: CONTRACT_DIMENSION,
      message: `即時功率／需量 ${Number(demandKw).toFixed(1)} kW 已達或超過契約容量 ${Number(contractKw).toFixed(1)} kW`,
    });
  } else {
    await resolveContractAlertQuietly();
  }
}

async function checkEnergyMeters() {
  const { config } = await energySettingsService.getSettings();
  const includeIds = config.include_device_ids || [];

  if (includeIds.length === 0) {
    await syncContractDemandAlert({
      enabled: false,
      demandKw: null,
      contractKw: config.contract_capacity_kw,
      hasSample: false,
    });
    return;
  }

  const devices = await db.query(
    `SELECT d.id, d.name, d.config as device_config
     FROM devices d
     WHERE d.id = ANY($1::int[])
       AND d.type_code = 'sensor'`,
    [includeIds],
  );

  let totalPower = 0;
  let totalDemand = 0;
  let hasDemand = false;
  let hasPowerSample = false;
  const now = Date.now();

  for (const device of devices || []) {
    const logging = await deviceLoggingConfig.getDeviceLoggingConfig(device.id);
    const energyValues = (logging.values || []).filter(
      (v) => v.enabled !== false && isValidEnergyParameterKey(v.name),
    );
    if (energyValues.length === 0) continue;

    const deviceConfig = buildDeviceConfig(device.device_config);
    if (!deviceConfig.host) {
      logger.warn("設備缺少 IP", { deviceId: device.id });
      continue;
    }

    let data = {};
    let online = false;
    try {
      data = await readMeterValues(energyValues, deviceConfig);
      online = Object.keys(data).length > 0;
    } catch (err) {
      logger.warn("表計讀取失敗", { deviceId: device.id, error: err.message });
    }

    if (online) {
      const lastWrite = lastRawWriteByDevice.get(device.id) || 0;
      if (now - lastWrite >= ENERGY_RAW_WRITE_INTERVAL_MS) {
        await energyReadingsService.saveReading({ deviceId: device.id, data });
        lastRawWriteByDevice.set(device.id, now);
      }
      if (typeof data.active_power === "number") {
        totalPower += data.active_power;
        hasPowerSample = true;
      }
      if (typeof data.demand === "number") {
        totalDemand += data.demand;
        hasDemand = true;
      }
    }

    websocketService.emitEnergyReadingNew({
      deviceId: device.id,
      deviceName: device.name,
      recordedAt: new Date().toISOString(),
      data,
      online,
    });
  }

  const hasSample = hasDemand || hasPowerSample;
  const demandKw = hasDemand ? totalDemand : hasPowerSample ? totalPower : null;
  await syncContractDemandAlert({
    enabled: config.demand_alert_enabled,
    demandKw,
    contractKw: config.contract_capacity_kw,
    hasSample,
  });
}

module.exports = {
  checkEnergyMeters,
};
