/**
 * 泛用 DI/DO 監控
 * - Fast：modbusPollPlanner 依 ioModules 區間讀 → BitStore
 * - 警報：啟用 di/do 規則 → create/resolve alert
 * - 營運事件：已配置 bit 0↔1（重啟首輪只建 baseline）
 */
const logger = require("../../utils/logger");
const db = require("../../database/db");
const alertService = require("../alerts/alertService");
const alertRuleService = require("../alerts/alertRuleService");
const { collectConfiguredBitPointsFromSystemConfig } = require("../devices/modbusDiDoConfig");
const operationalEventService = require("../operationalEvents/operationalEventService");
const {
  summaryStateChange,
  resolvePointLabel,
} = require("../operationalEvents/operationalEventCopy");
const { summaryBitTriggerFallback } = require("../alerts/alertCopy");
const {
  shouldSuppressCoilStateChange,
} = require("../operationalEvents/operationalEventHooks");
const { formatPlaceLabel } = require("../operationalEvents/operationalEventPlaceContext");
const modbusPollPlanner = require("../devices/modbusPollPlanner");
const bitStore = require("../devices/modbusBitStore");
const { DEVICE_CFG_TTL_MS } = require("../../config/realtimeTiming");

const getDeviceService = () => require("../devices/deviceService");

const SOURCE_TO_SYSTEM_TYPE = {
  environment: "environment",
  lighting: "lighting",
  drainage: "drainage",
  power: "power",
  hvac: "hvac",
  fire: "fire",
  emergency_rescue: "emergency_rescue",
  air_circulation: "air_circulation",
  smoke_alarm: "smoke_alarm",
  security: "security",
};

const CONFIGURED_SYSTEM_TYPES = Object.values(SOURCE_TO_SYSTEM_TYPE);

/** @type {Map<string, boolean>} */
const lastBitState = new Map();
/** @type {Set<string>} */
const baselinedKeys = new Set();

function parseBitKey(bitKey) {
  const m = String(bitKey || "").match(/^(di|do|discrete|coil):(\d+)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const registerType =
    kind === "di" || kind === "discrete" ? "discrete" : "coil";
  return { registerType, address: Number(m[2]) };
}

const deviceCfgCache = new Map();

async function resolveDeviceConfig(deviceId) {
  if (!deviceId) return null;
  const cached = deviceCfgCache.get(deviceId);
  if (cached && Date.now() - cached.ts < DEVICE_CFG_TTL_MS) return cached.cfg;
  try {
    const { device } = await getDeviceService().getDeviceById(Number(deviceId));
    const c = device?.config || {};
    if (!c.host || c.port == null) return null;
    const cfg = {
      host: String(c.host).trim(),
      port: Number(c.port),
      unitId: Number(c.unitId ?? 1),
    };
    deviceCfgCache.set(deviceId, { cfg, ts: Date.now() });
    return cfg;
  } catch {
    return null;
  }
}

async function resolveTargetSystems(rule) {
  const systemType = SOURCE_TO_SYSTEM_TYPE[rule.source];
  if (!systemType) return [];

  let whereClause = "";
  const params = [systemType];
  if (rule.target_type === "location" && rule.target_id != null) {
    whereClause = "AND ls.location_id = ?";
    params.push(rule.target_id);
  } else if (rule.target_type === "zone" && rule.target_id != null) {
    whereClause = "AND l.zone_id = ?";
    params.push(rule.target_id);
  }

  const rows = await db.query(
    `SELECT ls.id AS system_id,
            (ls.system_config->'device_ids'->>0)::integer AS device_id
     FROM location_systems ls
     JOIN locations l ON l.id = ls.location_id
     WHERE ls.system_type = ? ${whereClause}
       AND jsonb_array_length(COALESCE(ls.system_config->'device_ids', '[]'::jsonb)) > 0`,
    params,
  );

  return (rows || []).map((r) => ({
    systemId: r.system_id,
    deviceId: r.device_id,
  }));
}

async function loadConfiguredDiDoPoints() {
  const placeholders = CONFIGURED_SYSTEM_TYPES.map(() => "?").join(", ");
  const rows = await db.query(
    `
    SELECT
      ls.id AS system_id,
      ls.location_id,
      ls.system_type,
      ls.system_config,
      l.name AS location_name,
      z.name AS zone_name
    FROM location_systems ls
    LEFT JOIN locations l ON l.id = ls.location_id
    LEFT JOIN zones z ON l.zone_id = z.id
    WHERE ls.system_type IN (${placeholders})
      AND jsonb_array_length(COALESCE(ls.system_config->'device_ids', '[]'::jsonb)) > 0
    `,
    CONFIGURED_SYSTEM_TYPES,
  );

  const points = [];
  for (const row of rows || []) {
    const zoneName = row.zone_name != null ? String(row.zone_name).trim() : "";
    const locationName =
      row.location_name != null ? String(row.location_name).trim() : "";
    const placeLabel = formatPlaceLabel(zoneName, locationName);

    const bits = collectConfiguredBitPointsFromSystemConfig(row.system_config);
    for (const b of bits) {
      points.push({
        systemId: row.system_id,
        locationId: row.location_id,
        systemType: row.system_type,
        deviceId: b.deviceId,
        bitKey: b.bitKey,
        registerType: b.registerType,
        address: b.address,
        role: b.role,
        placeLabel,
      });
    }
  }
  return points;
}

async function syncDiDoAlert(rule, systemId, bitValue) {
  const dimensionKey =
    rule.dimension_key ||
    alertRuleService.deriveRuleDimensionKey({
      alert_type: rule.alert_type,
      condition_type: rule.condition_type,
      condition_config: rule.condition_config,
    });

  if (bitValue === true) {
    const severity = rule.severity || alertService.SEVERITIES.WARNING;
    let message = "";
    try {
      message = await alertRuleService.renderRuleMessage(rule, {
        source_id: systemId,
      });
    } catch {
      /* 渲染失敗不中斷 */
    }
    if (!message) {
      const parsed = parseBitKey(rule.condition_config?.bit_key);
      message = summaryBitTriggerFallback({
        alertType: rule.alert_type,
        channel: parsed?.address,
      });
    }

    if (rule.source === alertService.ALERT_SOURCES.SECURITY) {
      const {
        createOutsideScheduleAlert,
      } = require("../security/securityAlertGate");
      await createOutsideScheduleAlert({
        systemId,
        alertType: rule.alert_type,
        dimensionKey,
        message,
        severity,
        ruleId: rule.id,
      });
      return;
    }

    await alertService.createAlert({
      source: rule.source,
      source_id: Number(systemId),
      alert_type: rule.alert_type,
      dimension_key: dimensionKey,
      severity,
      message,
      rule_id: rule.id,
    });
    return;
  }

  try {
    await alertService.resolveAlert(
      Number(systemId),
      rule.alert_type,
      rule.source,
      dimensionKey,
    );
  } catch (err) {
    if (!String(err?.message || "").includes("未找到可更新的警報")) throw err;
  }
}

function recordStateEdge(point, bitValue, deviceConfig = null) {
  const stateKey = `${point.systemId}:${point.bitKey}`;
  if (!baselinedKeys.has(stateKey)) {
    lastBitState.set(stateKey, bitValue);
    baselinedKeys.add(stateKey);
    return;
  }
  const prev = lastBitState.get(stateKey);
  if (prev === bitValue) return;
  lastBitState.set(stateKey, bitValue);

  if (
    point.registerType === "coil" &&
    deviceConfig &&
    shouldSuppressCoilStateChange(deviceConfig, point.address)
  ) {
    return;
  }

  void operationalEventService.recordEvent({
    source: point.systemType,
    event_kind: "state_change",
    location_id: point.locationId,
    system_id: point.systemId,
    device_id: point.deviceId,
    bit_key: point.bitKey,
    address: point.address,
    old_value: prev,
    new_value: bitValue,
    message: summaryStateChange({
      source: point.systemType,
      bitKey: point.bitKey,
      address: point.address,
      newValue: bitValue,
      placeLabel: point.placeLabel || null,
      pointKey:
        point.role === "modbus_do"
          ? "isOn"
          : point.role === "modbus_di"
            ? null
            : point.role || null,
      pointLabel: resolvePointLabel(
        point.role === "modbus_do"
          ? "isOn"
          : point.role === "modbus_di"
            ? null
            : point.role || null,
        point.bitKey,
        point.address,
        "coil",
      ),
    }),
    payload: {
      bitKey: point.bitKey,
      role: point.role || null,
      oldValue: prev,
      newValue: bitValue,
    },
  });
}

/**
 * 單次：PollPlanner → BitStore → edge + 規則警報
 */
async function checkDiDoAlerts() {
  const monitorLogger = logger.createLogger("diDoMonitor");
  try {
    const registerTypes = new Set();
    const [configuredPoints, rules] = await Promise.all([
      loadConfiguredDiDoPoints(),
      alertRuleService.getEnabledDiDoRules(),
    ]);

    for (const p of configuredPoints) {
      if (p.registerType === "coil" || p.registerType === "discrete") {
        registerTypes.add(p.registerType);
      }
    }
    for (const rule of rules || []) {
      const parsed = parseBitKey(rule.condition_config?.bit_key);
      if (parsed?.registerType) registerTypes.add(parsed.registerType);
    }
    // 無消費點／規則時仍讀兩者，供模組離線偵測
    if (registerTypes.size === 0) {
      registerTypes.add("coil");
      registerTypes.add("discrete");
    }

    await modbusPollPlanner.pollControllers({
      registerTypes,
      broadcastStatus: true,
    });

    if (configuredPoints.length === 0 && !(rules || []).length) {
      return;
    }

    /** @type {Map<string, { deviceId: number, parsed: { registerType: string, address: number }, alertTasks: any[], edgePoints: any[] }>} */
    const readKeyMap = new Map();

    const ensureEntry = (deviceId, registerType, address) => {
      const key = `${deviceId}:${registerType}:${address}`;
      if (!readKeyMap.has(key)) {
        readKeyMap.set(key, {
          deviceId,
          parsed: { registerType, address },
          alertTasks: [],
          edgePoints: [],
        });
      }
      return readKeyMap.get(key);
    };

    for (const p of configuredPoints) {
      if (!p.deviceId) continue;
      ensureEntry(p.deviceId, p.registerType, p.address).edgePoints.push(p);
    }

    for (const rule of rules || []) {
      const parsed = parseBitKey(rule.condition_config?.bit_key);
      if (!parsed) continue;
      const systems = await resolveTargetSystems(rule);
      for (const sys of systems) {
        if (!sys.deviceId) continue;
        ensureEntry(sys.deviceId, parsed.registerType, parsed.address).alertTasks.push({
          rule,
          systemId: sys.systemId,
        });
      }
    }

    if (readKeyMap.size === 0) return;

    for (const entry of readKeyMap.values()) {
      const cfg = await resolveDeviceConfig(entry.deviceId);
      if (!cfg) continue;

      if (!bitStore.isModuleOnlineForAddress(cfg, entry.parsed.address)) {
        continue;
      }

      const hit = bitStore.getBitRaw(
        cfg,
        entry.parsed.registerType,
        entry.parsed.address,
      );
      if (!hit || !hit.ok) continue;
      const bitValue = Boolean(hit.value);

      for (const point of entry.edgePoints) {
        recordStateEdge(point, bitValue, cfg);
      }

      for (const task of entry.alertTasks) {
        try {
          await syncDiDoAlert(task.rule, task.systemId, bitValue);
        } catch (err) {
          monitorLogger.warn(
            `DI/DO 警報同步失敗 (rule=${task.rule.id}, system=${task.systemId})`,
            { error: err?.message || String(err) },
          );
        }
      }
    }
  } catch (error) {
    monitorLogger.warn("DI/DO 監控執行失敗（不影響其他任務）", {
      error: error?.message || String(error),
    });
  }
}

const DI_DO_ALERT_FEATURE_KEYS = [
  ...new Set(Object.values(SOURCE_TO_SYSTEM_TYPE)),
];

module.exports = {
  checkDiDoAlerts,
  DI_DO_ALERT_FEATURE_KEYS,
  /** @internal */
  _resetEdgeStateForTests: () => {
    lastBitState.clear();
    baselinedKeys.clear();
  },
};
