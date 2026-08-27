/**
 * 能源 Incident 偵測器（alert_rules 驅動；寫入平台 alerts）
 */
const alertService = require("../alerts/alertService");
const alertRuleService = require("../alerts/alertRuleService");
const energySettingsService = require("./energySettingsService");
const {
  summaryEnergyContractStage,
  summaryEnergyMeterStale,
  summaryEnergyReadingJump,
} = require("../alerts/alertCopy");
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

const lastActiveEnergyByDevice = new Map();
const recentDeltasByDevice = new Map();

let cachedEnergyRules = null;
let cachedEnergyRulesAt = 0;
const ENERGY_RULES_CACHE_MS = 1_000;

async function getEnergyRules() {
  const now = Date.now();
  if (cachedEnergyRules && now - cachedEnergyRulesAt < ENERGY_RULES_CACHE_MS) {
    return cachedEnergyRules;
  }
  cachedEnergyRules = await alertRuleService.getAllRulesForSource("energy", true);
  cachedEnergyRulesAt = now;
  return cachedEnergyRules || [];
}

function clearEnergyRulesCache() {
  cachedEnergyRules = null;
  cachedEnergyRulesAt = 0;
}

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

async function renderEnergyRuleMessage(rule, runtimeVars, fallbackBuilder) {
  try {
    const message = await alertRuleService.renderRuleMessage(rule, runtimeVars);
    if (message) return message;
  } catch (err) {
    logger.warn("能源警報訊息渲染失敗", {
      ruleId: rule.id,
      error: err?.message || String(err),
    });
  }
  return fallbackBuilder ? fallbackBuilder() : "";
}

function findContractStageRule(rules, level) {
  return rules.find(
    (r) =>
      r.condition_type === "energy_contract_stage" &&
      r.enabled !== false &&
      Number(r.condition_config?.level) === level,
  );
}

/**
 * 契約分級告警（1／2／3）：僅保留最高觸發級一筆
 */
async function syncContractDemandAlerts({ demandKw, contractKw, hasSample }) {
  const rules = await getEnergyRules();
  const contractRules = rules.filter(
    (r) => r.condition_type === "energy_contract_stage",
  );
  const contract = Number(contractKw) || 0;

  if (!contractRules.length || contract <= 0) {
    await resolveAllContractStageAlerts();
    return;
  }

  if (!hasSample || !Number.isFinite(Number(demandKw))) {
    await resolveAllContractStageAlerts();
    return;
  }

  const demand = Number(demandKw);
  const enabledRules = contractRules.filter((r) => r.enabled !== false);

  let activeLevel = null;
  for (let level = 3; level >= 1; level--) {
    const rule = findContractStageRule(enabledRules, level);
    if (!rule) continue;
    const pct = Number(rule.condition_config?.threshold_pct) || 0;
    if (pct <= 0) continue;
    if (demand >= (contract * pct) / 100) {
      activeLevel = level;
      break;
    }
  }

  await resolveLegacyContractAlerts();

  for (let level = 1; level <= 3; level++) {
    const dim = CONTRACT_STAGE_DIMS[level - 1];
    const rule = findContractStageRule(contractRules, level);
    if (activeLevel !== level || !rule || rule.enabled === false) {
      await resolveEnergyAlertQuietly(
        STATION_SOURCE_ID,
        alertService.ALERT_TYPES.THRESHOLD,
        dim,
      );
      continue;
    }

    const pct = Number(rule.condition_config?.threshold_pct) || 0;
    const message = await renderEnergyRuleMessage(
      rule,
      {
        source_id: STATION_SOURCE_ID,
        level,
        demand_kw: demand.toFixed(1),
        contract_kw: contract.toFixed(1),
        threshold_pct: String(Math.round(pct)),
      },
      () =>
        summaryEnergyContractStage({
          level,
          demandKw: demand,
          contractKw: contract,
          thresholdPct: pct,
        }),
    );

    await alertService.createAlert({
      source: alertService.ALERT_SOURCES.ENERGY,
      source_id: STATION_SOURCE_ID,
      alert_type: alertService.ALERT_TYPES.THRESHOLD,
      severity: rule.severity || alertService.SEVERITIES.WARNING,
      dimension_key: dim,
      message,
      rule_id: rule.id,
    });
  }
}

/**
 * 表計讀數逾時（納入設備）
 */
async function syncMeterStaleAlerts({
  latestByDeviceId,
  includeDeviceIds,
}) {
  const rules = await getEnergyRules();
  const staleRule = rules.find((r) => r.condition_type === "energy_meter_stale");
  const ids = includeDeviceIds || [];
  const staleMinutes = Math.max(
    1,
    Number(staleRule?.condition_config?.stale_minutes) || 15,
  );
  const staleMs = staleMinutes * 60 * 1000;
  const now = Date.now();

  for (const deviceId of ids) {
    if (!staleRule || staleRule.enabled === false) {
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
      const name = latest?.deviceName;
      const message = await renderEnergyRuleMessage(
        staleRule,
        {
          source_id: deviceId,
          source_display_name: name,
          stale_minutes: String(staleMinutes),
        },
        () =>
          summaryEnergyMeterStale({
            deviceName: name,
            deviceId,
            staleMinutes,
          }),
      );

      await alertService.createAlert({
        source: alertService.ALERT_SOURCES.ENERGY,
        source_id: deviceId,
        alert_type: alertService.ALERT_TYPES.OFFLINE,
        severity: staleRule.severity || alertService.SEVERITIES.CRITICAL,
        dimension_key: DIM_METER_STALE,
        message,
        rule_id: staleRule.id,
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
  deviceId,
  deviceName,
  activeEnergy,
  resolveWhenNoSample = false,
}) {
  const rules = await getEnergyRules();
  const jumpRule = rules.find((r) => r.condition_type === "energy_reading_jump");

  if (!jumpRule || jumpRule.enabled === false) {
    await resolveEnergyAlertQuietly(
      deviceId,
      alertService.ALERT_TYPES.THRESHOLD,
      DIM_READING_JUMP,
    );
    return;
  }

  if (!Number.isFinite(Number(activeEnergy))) {
    if (resolveWhenNoSample) {
      await resolveEnergyAlertQuietly(
        deviceId,
        alertService.ALERT_TYPES.THRESHOLD,
        DIM_READING_JUMP,
      );
    }
    return;
  }

  const multiplier = Number(jumpRule.condition_config?.multiplier) || 3;
  const minKwh = Number(jumpRule.condition_config?.min_kwh) || 10;

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

  const threshold = baseline > 0 ? baseline * multiplier : minKwh;
  const isJump = delta >= Math.max(minKwh, threshold) && deltas.length >= 2;

  if (isJump) {
    const message = await renderEnergyRuleMessage(
      jumpRule,
      {
        source_id: deviceId,
        source_display_name: deviceName,
        delta_kwh: delta.toFixed(1),
      },
      () =>
        summaryEnergyReadingJump({
          deviceName,
          deviceId,
          deltaKwh: delta,
        }),
    );

    await alertService.createAlert({
      source: alertService.ALERT_SOURCES.ENERGY,
      source_id: deviceId,
      alert_type: alertService.ALERT_TYPES.THRESHOLD,
      severity: jumpRule.severity || alertService.SEVERITIES.WARNING,
      dimension_key: DIM_READING_JUMP,
      message,
      rule_id: jumpRule.id,
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
  clearEnergyRulesCache,
  resolveEnergyAlertQuietly,
  resolveAllContractStageAlerts,
  syncContractDemandAlerts,
  syncMeterStaleAlerts,
  evaluateReadingJump,
  disableAllDeviceEnergyAlerts,
};
