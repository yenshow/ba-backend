/**
 * 照明系統：狀態快照（Modbus 讀取）
 * - 設備綁定 SSOT：`location_systems.system_config.device_ids`（非空），`device_ids[0]` 為主設備
 * - 對齊 HVAC：`deriveUiStatus` 僅判斷連線／可讀性；可同時讀 DI+DO，任一成即視為可讀
 * - DI/DO 位址與 `modbusDiDoConfig` 共用（避免與 HVAC 分叉）
 * - `raw.isOn`：有 DO 則以 DO，否則以 DI
 */

const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const modbusBatchService = require("../devices/modbusBatchService");
const { collectLightingDiDoReadSpecs } = require("./modbusDiDoConfig");
const systemAlert = require("../alerts/systemAlertHelper");
const alertService = require("../alerts/alertService");
const { loadActiveAlertSystemIdSet, mergeActiveAlertsIntoSnapshotItems } =
  systemAlert;
const logger = require("../../utils/logger");

const statusLogger = logger.createLogger("lightingStatusService");
const STATUS_CACHE_TTL_MS = Number(
  process.env.LIGHTING_STATUS_CACHE_TTL_MS || 1500,
);
const statusCache = new Map();

const DEVICE_CFG_CACHE_TTL_MS = Number(
  process.env.DEVICE_CFG_CACHE_TTL_MS || 60_000,
);
const DEVICE_CFG_CACHE_TTL = Number.isFinite(DEVICE_CFG_CACHE_TTL_MS)
  ? Math.max(1000, Math.floor(DEVICE_CFG_CACHE_TTL_MS))
  : 60_000;
const deviceCfgCache = new Map();

function getCachedDeviceCfg(deviceId) {
  const hit = deviceCfgCache.get(String(deviceId));
  if (!hit) return null;
  if (Date.now() - hit.ts > DEVICE_CFG_CACHE_TTL) {
    deviceCfgCache.delete(String(deviceId));
    return null;
  }
  return hit.cfg || null;
}

function setCachedDeviceCfg(deviceId, cfg) {
  deviceCfgCache.set(String(deviceId), { ts: Date.now(), cfg: cfg || null });
}

function parseInlineModbus(modbus) {
  if (!modbus || typeof modbus !== "object") return null;
  const { host, port, unitId = 1 } = modbus;
  if (!host || port === undefined || port === null) return null;
  return { host, port: Number(port), unitId: Number(unitId) };
}

async function resolveDeviceConfig(deviceId, modbus) {
  if (deviceId != null && deviceId !== "") {
    try {
      const cached = getCachedDeviceCfg(deviceId);
      if (cached) return cached;

      const { device } = await deviceService.getDeviceById(Number(deviceId));
      const c = device?.config || {};
      if (c.host != null && c.port !== undefined && c.port !== null) {
        const cfg = {
          host: c.host,
          port: Number(c.port),
          unitId: Number(c.unitId ?? 1),
        };
        setCachedDeviceCfg(deviceId, cfg);
        return cfg;
      }
    } catch (err) {
      statusLogger.debug?.("resolveDeviceConfig: device lookup failed", {
        deviceId,
        error: err?.message || String(err || ""),
      });
    }
  }
  return parseInlineModbus(modbus);
}

/**
 * 與 hvacStatusService 一致：只做連線／可讀性健康判定（不在此層做 alarm 分級）
 */
function deriveUiStatus(raw, hadDeviceConfig, pointKeysConfigured) {
  if (!hadDeviceConfig) return "offline";
  if (!pointKeysConfigured || pointKeysConfigured.length === 0)
    return "unknown";

  const anyRead = pointKeysConfigured.some(
    (k) => raw[k] !== undefined && raw[k] !== null,
  );
  if (!anyRead) return "warning";
  return "normal";
}

function mergeLightingRawFromBitResults(specs, results) {
  const raw = {};
  let firstReadError = null;
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const res = results?.[i];
    if (res?.ok === true) {
      const v = res.data?.[0];
      raw[spec.pointKey] = Boolean(v);
    } else if (!firstReadError) {
      firstReadError = res?.error || "無法讀取照明設備資料";
    }
  }
  // 開關顯示：有 DO 讀值則以 DO 為準（控制線圈），否則用 DI（回授）
  if (raw.do !== undefined) raw.isOn = raw.do;
  else if (raw.di !== undefined) raw.isOn = raw.di;
  return { raw, readError: firstReadError };
}

async function syncLightingConnectivityAlert(
  systemId,
  hadDeviceConfig,
  configuredKeys,
  raw,
  readError,
  syncAlerts,
) {
  if (!syncAlerts) return;
  if (!hadDeviceConfig || !configuredKeys || configuredKeys.length === 0)
    return;
  const anyRead = configuredKeys.some(
    (k) => raw[k] !== undefined && raw[k] !== null,
  );
  await systemAlert.syncLocationSnapshotReadResult(
    "lighting",
    systemId,
    anyRead,
    readError || "無法讀取照明設備資料",
  );
}

function parseZoneIds(zoneIds) {
  if (!Array.isArray(zoneIds) || zoneIds.length === 0) {
    return [];
  }
  return zoneIds.map((id) => Number(id)).filter((id) => Number.isFinite(id));
}

async function fetchLightingSystems(zoneIds = []) {
  const hasZoneFilter = Array.isArray(zoneIds) && zoneIds.length > 0;
  const sql = `
    SELECT
      z.id AS zone_id,
      z.name AS zone_name,
      l.id AS location_id,
      l.name AS location_name,
      ls.id AS system_id,
      (ls.system_config->'device_ids'->>0)::int AS device_id,
      ls.system_config->'modbus_config' AS modbus_config
    FROM location_systems ls
    INNER JOIN locations l ON l.id = ls.location_id
    INNER JOIN zones z ON z.id = l.zone_id
    WHERE ls.system_type = 'lighting'
      AND jsonb_array_length(COALESCE(ls.system_config->'device_ids', '[]'::jsonb)) > 0
      AND (ls.system_config->'device_ids'->>0) ~ '^[0-9]+$'
      AND ls.system_config->'modbus_config' IS NOT NULL
      AND ls.system_config->'modbus_config' != '{}'::jsonb
      ${hasZoneFilter ? "AND z.id = ANY($1::int[])" : ""}
  `;

  return hasZoneFilter ? db.query(sql, [zoneIds]) : db.query(sql);
}

async function buildLightingSnapshotItem(row, options = {}) {
  const { syncAlerts = true } = options;
  const systemId = Number(row.system_id);
  const deviceId = row.device_id ? Number(row.device_id) : null;
  const baseItem = {
    zoneId: String(row.zone_id),
    zoneName: row.zone_name,
    locationId: String(row.location_id),
    locationName: row.location_name,
    systemId: String(systemId),
    uiStatus: "offline",
    raw: {},
  };

  const modbusConfigRaw =
    typeof row.modbus_config === "string"
      ? JSON.parse(row.modbus_config)
      : row.modbus_config;

  if (!modbusConfigRaw || Object.keys(modbusConfigRaw).length === 0) {
    const readError = "配置為空";
    if (syncAlerts) {
      await systemAlert.syncLocationSnapshotReadResult(
        "lighting",
        systemId,
        false,
        readError,
      );
    }
    return {
      ...baseItem,
      error: readError,
      uiStatus: deriveUiStatus({}, false, []),
    };
  }

  const bitSpecs = collectLightingDiDoReadSpecs(modbusConfigRaw);
  if (bitSpecs.length === 0) {
    const readError = "未配置 DI/DO 點位";
    if (syncAlerts) {
      await systemAlert.syncLocationSnapshotReadResult(
        "lighting",
        systemId,
        false,
        readError,
      );
    }
    const hadCfg = Boolean(await resolveDeviceConfig(deviceId, modbusConfigRaw));
    return {
      ...baseItem,
      error: readError,
      uiStatus: deriveUiStatus({}, hadCfg, []),
    };
  }

  const deviceConfig = await resolveDeviceConfig(deviceId, modbusConfigRaw);
  const hadDeviceConfig = Boolean(deviceConfig);
  if (!deviceConfig) {
    const readError = "配置不完整";
    if (syncAlerts) {
      await systemAlert.syncLocationSnapshotReadResult(
        "lighting",
        systemId,
        false,
        readError,
      );
    }
    return {
      ...baseItem,
      deviceId: deviceId ?? undefined,
      error: readError,
      uiStatus: deriveUiStatus({}, false, ["isOn"]),
    };
  }

  // 與 HVAC 多鍵語意一致：任一成讀值即視為可讀（deriveUiStatus 用 anyRead）
  const configuredKeys = ["isOn", "di", "do"];
  let readError = null;
  let raw = {};

  try {
    const batch = bitSpecs.map((spec) => ({
      host: deviceConfig.host,
      port: deviceConfig.port,
      unitId: deviceConfig.unitId,
      registerType: spec.registerType,
      address: spec.address,
      length: 1,
      meta: { systemId, pointKey: spec.pointKey },
    }));
    const results = await modbusBatchService.batchRead(batch);
    const merged = mergeLightingRawFromBitResults(bitSpecs, results);
    raw = merged.raw;
    readError = merged.readError;
  } catch (err) {
    readError = err?.message || String(err || "無法讀取照明設備資料");
    raw = {};
  }

  const uiStatus = deriveUiStatus(raw, hadDeviceConfig, configuredKeys);

  try {
    await syncLightingConnectivityAlert(
      systemId,
      hadDeviceConfig,
      configuredKeys,
      raw,
      readError,
      syncAlerts,
    );
  } catch (alertErr) {
    statusLogger.warn("同步警報失敗（略過）", {
      systemId,
      error: alertErr?.message || String(alertErr),
      module: "lightingStatusService",
    });
  }

  return {
    ...baseItem,
    deviceId: deviceId ?? undefined,
    uiStatus,
    raw,
    ...(readError ? { error: readError } : {}),
  };
}

async function getStatusSnapshot(query = {}) {
  const zoneIds = parseZoneIds(query.zoneIds);
  const syncAlerts = query.syncAlerts !== false;
  const cacheKey = `${
    zoneIds
      .slice()
      .sort((a, b) => a - b)
      .join(",") || "all"
  }`;
  const canUseCache = !syncAlerts && STATUS_CACHE_TTL_MS > 0;
  const cached = statusCache.get(cacheKey);
  if (canUseCache && cached && Date.now() - cached.ts <= STATUS_CACHE_TTL_MS) {
    return cached.value;
  }

  const rows = await fetchLightingSystems(zoneIds);

  if (!rows || rows.length === 0) {
    const emptyResult = { items: [] };
    if (canUseCache) {
      statusCache.set(cacheKey, { ts: Date.now(), value: emptyResult });
    }
    return emptyResult;
  }

  const items = await Promise.all(
    rows.map((row) => buildLightingSnapshotItem(row, { syncAlerts })),
  );
  const systemIds = items
    .map((it) => Number(it.systemId))
    .filter((n) => Number.isFinite(n));
  const activeAlertSystemIds = await loadActiveAlertSystemIdSet(
    alertService.ALERT_SOURCES.LIGHTING,
    systemIds,
  );
  const merged = mergeActiveAlertsIntoSnapshotItems(
    items,
    activeAlertSystemIds,
  );
  const result = { items: merged };
  if (canUseCache) {
    statusCache.set(cacheKey, { ts: Date.now(), value: result });
  }
  return result;
}

async function getZoneStatusSnapshot(zoneId, query = {}) {
  const id = Number(zoneId);
  const syncAlerts = query.syncAlerts !== false;
  if (!Number.isFinite(id)) {
    return { zoneId: String(zoneId), items: [] };
  }

  const result = await getStatusSnapshot({
    zoneIds: [id],
    syncAlerts,
  });
  return { zoneId: String(id), items: result.items };
}

module.exports = {
  getStatusSnapshot,
  getZoneStatusSnapshot,
};
