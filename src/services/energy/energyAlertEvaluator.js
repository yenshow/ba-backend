/**
 * 能源 Incident 內建偵測器（寫入平台 alerts）
 */
const alertService = require("../alerts/alertService");
const energySettingsService = require("./energySettingsService");
const logger = require("../../utils/logger").createLogger("energyAlertEvaluator");

const STATION_SOURCE_ID = energySettingsService.SETTINGS_ID;

/** @deprecated 舊兩段契約 key；啟動／同步時結案避免殘留 */
const LEGACY_DIM_CONTRACT_WARN = "contract_demand_warn";
const LEGACY_DIM_CONTRACT_OVER = "contract_demand";

const DIM_CONTRACT_STAGE_1 = "contract_stage_1";
const DIM_CONTRACT_STAGE_2 = "contract_stage_2";
const DIM_CONTRACT_STAGE_3 = "contract_stage_3";
const DIM_METER_STALE = "meter_stale";
const DIM_READING_JUMP = "reading_jump";

const CONTRACT_STAGE_DIMS = [
  DIM_CONTRACT_STAGE_1,
  DIM_CONTRACT_STAGE_2,
  DIM_CONTRACT_STAGE_3,
];

const STAGE_SEVERITY = {
  1: alertService.SEVERITIES.WARNING,
  2: alertService.SEVERITIES.ERROR,
  3: alertService.SEVERITIES.CRITICAL,
};

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

async function resolveLegacyContractAlerts() {
  await resolveEnergyAlertQuietly(
    STATION_SOURCE_ID,
    alertService.ALERT_TYPES.THRESHOLD,
    LEGACY_DIM_CONTRACT_WARN,
  );
  await resolveEnergyAlertQuietly(
    STATION_SOURCE_ID,
    alertService.ALERT_TYPES.THRESHOLD,
    LEGACY_DIM_CONTRACT_OVER,
  );
}

async function resolveAllContractStageAlerts() {
  for (const dim of CONTRACT_STAGE_DIMS) {
    await resolveEnergyAlertQuietly(
      STATION_SOURCE_ID,
      alertService.ALERT_TYPES.THRESHOLD,
      dim,
    );
  }
  await resolveLegacyContractAlerts();
}

/**
 * 契約分級告警（1／2／3）：僅保留最高觸發級一筆
 */
async function syncContractDemandAlerts({
  stages,
  demandKw,
  contractKw,
  hasSample,
}) {
  const contract = Number(contractKw) || 0;
  const normalized =
    Array.isArray(stages) && stages.length > 0
      ? stages
      : energySettingsService.DEFAULT_LOAD_SHED_STAGES;

  const anyEnabled = normalized.some((s) => s.enabled !== false);
  if (contract <= 0 || !anyEnabled) {
    await resolveAllContractStageAlerts();
    return;
  }

  if (!hasSample || !Number.isFinite(Number(demandKw))) {
    await resolveAllContractStageAlerts();
    return;
  }

  const demand = Number(demandKw);

  let activeLevel = null;
  for (let i = normalized.length - 1; i >= 0; i--) {
    const stage = normalized[i];
    if (stage.enabled === false) continue;
    const pct = Number(stage.threshold_pct) || 0;
    if (pct <= 0) continue;
    if (demand >= (contract * pct) / 100) {
      activeLevel = Number(stage.level);
      break;
    }
  }

  await resolveLegacyContractAlerts();

  for (let level = 1; level <= 3; level++) {
    const dim = CONTRACT_STAGE_DIMS[level - 1];
    if (activeLevel !== level) {
      await resolveEnergyAlertQuietly(
        STATION_SOURCE_ID,
        alertService.ALERT_TYPES.THRESHOLD,
        dim,
      );
      continue;
    }
    const stage = normalized.find((s) => Number(s.level) === level);
    const pct = Number(stage?.threshold_pct) || 0;
    await alertService.createAlert({
      source: alertService.ALERT_SOURCES.ENERGY,
      source_id: STATION_SOURCE_ID,
      alert_type: alertService.ALERT_TYPES.THRESHOLD,
      severity: STAGE_SEVERITY[level] || alertService.SEVERITIES.WARNING,
      dimension_key: dim,
      message: `契約 ${level} 級：即時功率／需量 ${demand.toFixed(1)} kW 已達契約容量 ${contract.toFixed(1)} kW 的 ${pct}%`,
    });
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
  DIM_CONTRACT_STAGE_1,
  DIM_CONTRACT_STAGE_2,
  DIM_CONTRACT_STAGE_3,
  DIM_METER_STALE,
  DIM_READING_JUMP,
  resolveEnergyAlertQuietly,
  resolveAllContractStageAlerts,
  syncContractDemandAlerts,
  syncMeterStaleAlerts,
  evaluateReadingJump,
  disableAllDeviceEnergyAlerts,
};
