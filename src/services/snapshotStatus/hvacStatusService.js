/**
 * HVAC：依 location_systems 設定讀取 Modbus 並合成 uiStatus（與排水/電力同風格：獨立檔案、共用底層）
 *
 * 主要用途：提供 `/api/hvac/status` 與 `/api/hvac/zones/:id/status` 的後端快照彙總。
 * - HVAC 的 location_systems.config 允許 `statusPoints`（holding/input 等數值點位）
 * - `modbus_config`（DI/DO）主要供控制回路使用；本服務以 statusPoints 為狀態快照主體
 * - DI/DO 位址解析與 `modbusDiDoConfig` 共用（與照明一致，避免分叉）
 */

const locationService = require("../location/locationService");
const { pickPrimaryDiDoBitRead } = require("../devices/modbusDiDoConfig");
const modbusBatchService = require("../devices/modbusBatchService");
const {
  ALLOWED_REGISTER_TYPES,
  resolveDeviceConfig,
  normalizeRegisterType,
  deriveConnectivityUiStatus: deriveUiStatus,
} = require("./modbusSnapshotHelpers");
const systemAlert = require("../alerts/systemAlertHelper");
const alertService = require("../alerts/alertService");
const { loadActiveAlertSystemIdSet, mergeActiveAlertsIntoSnapshotItems } =
  systemAlert;
const logger = require("../../utils/logger");
const { applyDefTransform } = require("../../utils/modbusTransform");

const statusLogger = logger.createLogger("hvacStatusService");

async function readPrimaryBitPoint(modbus, cfgDeviceId) {
  const primary = pickPrimaryDiDoBitRead(modbus);
  if (!primary) return { ok: false, error: "未配置 DI/DO 點位" };

  const conn = await resolveDeviceConfig(cfgDeviceId, modbus);
  if (!conn) return { ok: false, error: null };

  const results = await modbusBatchService.batchRead([
    {
      host: conn.host,
      port: conn.port,
      unitId: conn.unitId,
      registerType: primary.registerType,
      address: primary.address,
      length: 1,
      meta: { pointKey: "isOn" },
    },
  ]);

  const first = results?.[0];
  if (!first || first.ok !== true) {
    return { ok: false, error: first?.error || "無法讀取空調 DI/DO 狀態" };
  }
  return { ok: true, value: Boolean(first.data?.[0]) };
}

async function readAllPoints(statusPoints, cfgDeviceId, cfgModbus) {
  const raw = {};
  if (!statusPoints || typeof statusPoints !== "object") return raw;

  const reqs = [];
  for (const key of Object.keys(statusPoints)) {
    const def = statusPoints[key];
    if (!def || typeof def !== "object") continue;
    const registerType = normalizeRegisterType(def);
    const address = Number(def.address);
    const length = def.length != null ? Number(def.length) : 1;

    if (!Number.isFinite(address) || address < 0) {
      raw[key] = undefined;
      continue;
    }
    if (!Number.isFinite(length) || length <= 0) {
      raw[key] = undefined;
      continue;
    }
    if (!ALLOWED_REGISTER_TYPES.has(registerType)) {
      raw[key] = undefined;
      continue;
    }

    let pointDeviceConfig = null;
    try {
      const ownId = def.deviceId != null && def.deviceId !== "";
      pointDeviceConfig = ownId
        ? await resolveDeviceConfig(Number(def.deviceId), def.modbus || null)
        : await resolveDeviceConfig(cfgDeviceId, cfgModbus);
    } catch (_) {
      pointDeviceConfig = null;
    }
    if (!pointDeviceConfig) {
      raw[key] = undefined;
      continue;
    }

    reqs.push({
      host: pointDeviceConfig.host,
      port: pointDeviceConfig.port,
      unitId: pointDeviceConfig.unitId,
      registerType,
      address,
      length,
      meta: { pointKey: key },
    });
  }

  if (reqs.length === 0) return raw;

  const results = await modbusBatchService.batchRead(reqs);
  for (const r of results) {
    const k = r?.meta?.pointKey;
    if (!k) continue;
    if (!r.ok) {
      raw[k] = undefined;
      continue;
    }
    let value = r.data?.[0];
    const def = statusPoints[k];
    if (value != null && Number.isFinite(Number(value))) {
      value = applyDefTransform(Number(value), def);
    }
    raw[k] = value;
  }
  return raw;
}

async function hasResolvableDeviceForPoints(
  statusPoints,
  cfgDeviceId,
  cfgModbus,
) {
  const keys = Object.keys(statusPoints || {}).filter(
    (k) => statusPoints[k] && typeof statusPoints[k] === "object",
  );
  if (keys.length === 0) {
    try {
      return Boolean(await resolveDeviceConfig(cfgDeviceId, cfgModbus));
    } catch (_) {
      return false;
    }
  }
  for (const key of keys) {
    const def = statusPoints[key];
    let c = null;
    try {
      const ownId = def.deviceId != null && def.deviceId !== "";
      c = ownId
        ? await resolveDeviceConfig(Number(def.deviceId), def.modbus || null)
        : await resolveDeviceConfig(cfgDeviceId, cfgModbus);
    } catch (_) {
      c = null;
    }
    if (c) return true;
  }
  return false;
}

async function syncConnectivityAlert(
  systemId,
  hadDeviceConfig,
  pointKeys,
  raw,
  readError,
) {
  if (!hadDeviceConfig || !pointKeys || pointKeys.length === 0) return;
  const anyRead = pointKeys.some(
    (k) => raw[k] !== undefined && raw[k] !== null,
  );
  await systemAlert.syncLocationSnapshotReadResult(
    "hvac",
    systemId,
    anyRead,
    readError || "無法讀取空調設備資料",
  );
}

function collectItemsFromZones(zones) {
  const items = [];
  for (const zone of zones) {
    const locs = zone.locations || [];
    for (const loc of locs) {
      const systems = loc.systems || [];
      for (const sys of systems) {
        if (sys.systemType === "hvac") {
          items.push({ zone, location: loc, system: sys });
        }
      }
    }
  }
  return items;
}

async function buildItem(zone, location, system) {
  const cfg = system.config || {};
  const deviceId = cfg.deviceId;
  const modbus = cfg.modbus;
  const statusPoints = cfg.statusPoints || {};

  const pointKeys = Object.keys(statusPoints).filter(
    (k) => statusPoints[k] && typeof statusPoints[k] === "object",
  );

  const hadDeviceConfig =
    Boolean(await resolveDeviceConfig(deviceId, modbus)) ||
    (await hasResolvableDeviceForPoints(statusPoints, deviceId, modbus));

  let raw = {};
  let readError = null;
  try {
    if (pointKeys.length > 0) {
      raw = await readAllPoints(statusPoints, deviceId, modbus);
    }
    if (modbus && typeof modbus === "object") {
      const on = await readPrimaryBitPoint(modbus, deviceId);
      if (on.ok) {
        raw.isOn = on.value;
      } else if (!readError) {
        readError = on.error;
      }
    }
  } catch (err) {
    readError = err?.message || String(err);
    raw = {};
  }

  const configuredKeys = [...pointKeys, ...(modbus ? ["isOn"] : [])];
  const uiStatus = deriveUiStatus(raw, hadDeviceConfig, configuredKeys);
  try {
    await syncConnectivityAlert(
      Number(system.id),
      hadDeviceConfig,
      configuredKeys,
      raw,
      readError,
    );
  } catch (alertErr) {
    statusLogger.warn("同步警報失敗（略過）", {
      systemId: Number(system.id),
      error: alertErr?.message || String(alertErr),
      module: "hvacStatusService",
    });
  }

  return {
    zoneId: String(zone.id),
    zoneName: zone.name,
    locationId: String(location.id),
    locationName: location.name,
    systemId: String(system.id),
    uiStatus,
    raw,
    ...(readError ? { error: readError } : {}),
  };
}

async function getStatusSnapshot(query = {}) {
  const zoneIdsFilter = Array.isArray(query.zoneIds) ? query.zoneIds : [];

  const result = await locationService.getZones({ locationType: "hvac" });
  let zones = result.zones || [];
  if (zoneIdsFilter.length > 0) {
    const want = new Set(zoneIdsFilter.map((id) => String(id)));
    zones = zones.filter((z) => want.has(String(z.id)));
  }

  const triples = collectItemsFromZones(zones);
  const systemIds = triples
    .map((t) => Number(t.system?.id))
    .filter((n) => Number.isFinite(n));
  const activeAlertSystemIds = await loadActiveAlertSystemIdSet(
    alertService.ALERT_SOURCES.HVAC,
    systemIds,
  );
  const items = await Promise.all(
    triples.map(({ zone, location, system }) =>
      buildItem(zone, location, system),
    ),
  );
  return {
    items: mergeActiveAlertsIntoSnapshotItems(items, activeAlertSystemIds),
  };
}

async function getZoneStatusSnapshot(zoneId, query = {}) {
  const result = await locationService.getZoneById(zoneId, "hvac");
  const zone = result.zone;
  const triples = collectItemsFromZones([zone]);
  const systemIds = triples
    .map((t) => Number(t.system?.id))
    .filter((n) => Number.isFinite(n));
  const activeAlertSystemIds = await loadActiveAlertSystemIdSet(
    alertService.ALERT_SOURCES.HVAC,
    systemIds,
  );
  const items = await Promise.all(
    triples.map(({ zone: z, location, system }) =>
      buildItem(z, location, system),
    ),
  );
  return {
    zoneId: String(zone.id),
    items: mergeActiveAlertsIntoSnapshotItems(items, activeAlertSystemIds),
  };
}

module.exports = {
  getStatusSnapshot,
  getZoneStatusSnapshot,
};
