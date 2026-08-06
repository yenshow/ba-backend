/**
 * 能源 Incident 內建偵測器（寫入平台 alerts）
 */
const alertService = require("../alerts/alertService");
const energySettingsService = require("./energySettingsService");
const logger = require("../../utils/logger").createLogger("energyAlertEvaluator");

const STATION_SOURCE_ID = energySettingsService.SETTINGS_ID;
const DIM_CONTRACT_WARN = "contract_demand_warn";
const DIM_CONTRACT_OVER = "contract_demand";
const DIM_METER_STALE = "meter_stale";
const DIM_READING_JUMP = "reading_jump";

const lastActiveEnergyByDevice = new Map();
const recentDeltasByDevice = new Map();

async function resolveEnergyAlertQuietly(sourceId, alertType, dimensionKey) {
  try {
    await alertService.resolveAlert(
      sourceId,
      alertType,
      alertService.ALERT_SOURCES.ENERGY,
      dimensionKey,
    );
  } catch (err) {
    const msg = err?.message || String(err);
    if (!msg.includes("未找到可更新的警報")) {
      logger.warn("結案能源告警失敗", {
        sourceId,
        alertType,
        dimensionKey,
        error: msg,
      });
    }
  }
}

/**
 * 契約接近預警 + 超限（兩段 dimension_key）
 */
async function syncContractDemandAlerts({
  warningEnabled,
  alertEnabled,
  warningPct,
  demandKw,
  contractKw,
  hasSample,
}) {
  const contract = Number(contractKw) || 0;

  if (contract <= 0 || (!warningEnabled && !alertEnabled)) {
    await resolveEnergyAlertQuietly(
      STATION_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_CONTRACT_WARN,
    );
    await resolveEnergyAlertQuietly(
      STATION_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_CONTRACT_OVER,
    );
    return;
  }

  if (!hasSample || !Number.isFinite(Number(demandKw))) {
    await resolveEnergyAlertQuietly(
      STATION_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_CONTRACT_WARN,
    );
    await resolveEnergyAlertQuietly(
      STATION_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_CONTRACT_OVER,
    );
    return;
  }

  const demand = Number(demandKw);
  const warnThreshold = contract * (Number(warningPct) || 90) / 100;
  const over = demand >= contract;
  const warn = !over && demand >= warnThreshold;

  if (!alertEnabled) {
    await resolveEnergyAlertQuietly(
      STATION_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_CONTRACT_OVER,
    );
  }

  if (!warningEnabled) {
    await resolveEnergyAlertQuietly(
      STATION_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_CONTRACT_WARN,
    );
  }

  if (over && alertEnabled) {
    await resolveEnergyAlertQuietly(
      STATION_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_CONTRACT_WARN,
    );
    await alertService.createAlert({
      source: alertService.ALERT_SOURCES.ENERGY,
      source_id: STATION_SOURCE_ID,
      alert_type: alertService.ALERT_TYPES.THRESHOLD,
      severity: alertService.SEVERITIES.ERROR,
      dimension_key: DIM_CONTRACT_OVER,
      message: `即時功率／需量 ${demand.toFixed(1)} kW 已達或超過契約容量 ${contract.toFixed(1)} kW`,
    });
    return;
  }

  await resolveEnergyAlertQuietly(
    STATION_SOURCE_ID,
    alertService.ALERT_TYPES.THRESHOLD,
    DIM_CONTRACT_OVER,
  );

  if (warn && warningEnabled) {
    await alertService.createAlert({
      source: alertService.ALERT_SOURCES.ENERGY,
      source_id: STATION_SOURCE_ID,
      alert_type: alertService.ALERT_TYPES.THRESHOLD,
      severity: alertService.SEVERITIES.WARNING,
      dimension_key: DIM_CONTRACT_WARN,
      message: `即時功率／需量 ${demand.toFixed(1)} kW 接近契約容量 ${contract.toFixed(1)} kW（預警）`,
    });
  } else {
    await resolveEnergyAlertQuietly(
      STATION_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_CONTRACT_WARN,
    );
  }
}

/**
 * 表計讀數逾時（納入設備）
 * @param {{ enabled: boolean, staleMinutes: number, latestByDeviceId: Map<number, { recordedAt: Date, deviceName: string }>, includeDeviceIds: number[] }} opts
 */
async function syncMeterStaleAlerts({
  enabled,
  staleMinutes,
  latestByDeviceId,
  includeDeviceIds,
}) {
  const ids = includeDeviceIds || [];
  const staleMs = Math.max(1, Number(staleMinutes) || 15) * 60 * 1000;
  const now = Date.now();

  for (const deviceId of ids) {
    if (!enabled) {
      await resolveEnergyAlertQuietly(
        deviceId,
        alertService.ALERT_TYPES.OFFLINE,
        DIM_METER_STALE,
      );
      continue;
    }

    const latest = latestByDeviceId.get(deviceId);
    const isStale =
      !latest ||
      !latest.recordedAt ||
      now - new Date(latest.recordedAt).getTime() > staleMs;

    if (isStale) {
      const name = latest?.deviceName || `設備 #${deviceId}`;
      const mins = Math.max(1, Number(staleMinutes) || 15);
      await alertService.createAlert({
        source: alertService.ALERT_SOURCES.ENERGY,
        source_id: deviceId,
        alert_type: alertService.ALERT_TYPES.OFFLINE,
        severity: alertService.SEVERITIES.CRITICAL,
        dimension_key: DIM_METER_STALE,
        message: `${name}：通訊逾時，最近 ${mins} 分鐘無讀數`,
      });
    } else {
      await resolveEnergyAlertQuietly(
        deviceId,
        alertService.ALERT_TYPES.OFFLINE,
        DIM_METER_STALE,
      );
    }
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * 累積量單次差分跳動
 */
async function evaluateReadingJump({
  enabled,
  deviceId,
  deviceName,
  activeEnergy,
  multiplier,
  minKwh,
}) {
  if (!enabled) {
    await resolveEnergyAlertQuietly(
      deviceId,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_READING_JUMP,
    );
    return;
  }

  if (!Number.isFinite(Number(activeEnergy))) {
    return;
  }

  const energy = Number(activeEnergy);
  const prev = lastActiveEnergyByDevice.get(deviceId);
  lastActiveEnergyByDevice.set(deviceId, energy);

  if (prev == null || !Number.isFinite(prev)) {
    return;
  }

  const delta = energy - prev;
  if (delta <= 0) {
    await resolveEnergyAlertQuietly(
      deviceId,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_READING_JUMP,
    );
    return;
  }

  const deltas = recentDeltasByDevice.get(deviceId) || [];
  const baseline = median(deltas);
  recentDeltasByDevice.set(deviceId, [...deltas, delta].slice(-8));

  const mult = Number(multiplier) || 3;
  const minJump = Number(minKwh) || 10;
  const threshold =
    baseline > 0 ? baseline * mult : minJump;
  const isJump = delta >= Math.max(minJump, threshold) && deltas.length >= 2;

  if (isJump) {
    await alertService.createAlert({
      source: alertService.ALERT_SOURCES.ENERGY,
      source_id: deviceId,
      alert_type: alertService.ALERT_TYPES.THRESHOLD,
      severity: alertService.SEVERITIES.WARNING,
      dimension_key: DIM_READING_JUMP,
      message: `${deviceName || `設備 #${deviceId}`}：讀數跳動異常（單次 +${delta.toFixed(1)} kWh）`,
    });
  } else {
    await resolveEnergyAlertQuietly(
      deviceId,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_READING_JUMP,
    );
  }
}

async function disableAllDeviceEnergyAlerts(deviceIds) {
  for (const deviceId of deviceIds || []) {
    lastActiveEnergyByDevice.delete(deviceId);
    recentDeltasByDevice.delete(deviceId);
    await resolveEnergyAlertQuietly(
      deviceId,
      alertService.ALERT_TYPES.OFFLINE,
      DIM_METER_STALE,
    );
    await resolveEnergyAlertQuietly(
      deviceId,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_READING_JUMP,
    );
  }
}

module.exports = {
  DIM_CONTRACT_WARN,
  DIM_CONTRACT_OVER,
  DIM_METER_STALE,
  DIM_READING_JUMP,
  resolveEnergyAlertQuietly,
  syncContractDemandAlerts,
  syncMeterStaleAlerts,
  evaluateReadingJump,
  disableAllDeviceEnergyAlerts,
};
