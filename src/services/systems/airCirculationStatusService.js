/**
 * 空氣循環：依 location_systems 設定讀取 Modbus 並合成 uiStatus
 * - 以 statusPoints 為主要狀態來源（可含 holding/input/coil/discrete）
 * - 若無可用控制器連線或讀值全失敗 → offline / warning
 */

const locationService = require("./locationService");
const deviceService = require("../devices/deviceService");
const modbusBatchService = require("../devices/modbusBatchService");
const systemAlert = require("../alerts/systemAlertHelper");
const logger = require("../../utils/logger");

const statusLogger = logger.createLogger("airCirculationStatusService");

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

const ALLOWED_REGISTER_TYPES = new Set([
  "coil",
  "discrete",
  "holding",
  "input",
]);

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
      const c = device.config || {};
      if (c.host != null && c.port !== undefined && c.port !== null) {
        const cfg = {
          host: c.host,
          port: Number(c.port),
          unitId: Number(c.unitId ?? 1),
        };
        setCachedDeviceCfg(deviceId, cfg);
        return cfg;
      }
    } catch (_) {
      /* fallback inline */
    }
  }
  return parseInlineModbus(modbus);
}

function normalizeRegisterType(pointDef) {
  let registerType = String(pointDef.registerType || pointDef.type || "")
    .toLowerCase()
    .trim();
  if (registerType === "di") registerType = "discrete";
  if (registerType === "do") registerType = "coil";
  return registerType;
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
    if (r.ok) {
      const v = r.data?.[0];
      raw[k] = v;
    } else {
      raw[k] = undefined;
    }
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

function deriveUiStatus(
  equipmentKind,
  raw,
  hadDeviceConfig,
  pointKeysConfigured,
) {
  if (!hadDeviceConfig) return "warning";
  if (!pointKeysConfigured || pointKeysConfigured.length === 0)
    return "unknown";

  const kind = equipmentKind === "tank" ? "tank" : "pump";
  const anyRead = pointKeysConfigured.some(
    (k) => raw[k] !== undefined && raw[k] !== null,
  );
  if (!anyRead) return "warning";

  if (kind === "pump") {
    if (raw.fault === true) return "alarm";
    if (raw.running === true) return "alarm";
    return "normal";
  }

  if (raw.coverAlarm === true || raw.highLevel === true) return "alarm";
  if (raw.levelOk === false) return "alarm";
  if (raw.lowLevel === true) return "alarm";
  return "normal";
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
    "air_circulation",
    systemId,
    anyRead,
    readError || "無法讀取空氣循環設備資料",
  );
}

function collectItemsFromZones(zones) {
  const items = [];
  for (const zone of zones) {
    const locs = zone.locations || [];
    for (const loc of locs) {
      const systems = loc.systems || [];
      for (const sys of systems) {
        if (sys.systemType === "air_circulation") {
          items.push({ zone, location: loc, system: sys });
        }
      }
    }
  }
  return items;
}

async function buildItem(zone, location, system, options = {}) {
  const { syncAlerts = true } = options || {};
  const cfg = system.config || {};
  const deviceId = cfg.deviceId;
  const modbus = cfg.modbus;
  const equipmentKind = cfg.equipmentKind || "pump";
  const viewCategory = cfg.viewCategory || "air_circulation";
  const statusPoints = cfg.statusPoints || {};

  const pointKeys = Object.keys(statusPoints).filter(
    (k) => statusPoints[k] && typeof statusPoints[k] === "object",
  );

  const hadDeviceConfig = await hasResolvableDeviceForPoints(
    statusPoints,
    deviceId,
    modbus,
  );

  let raw = {};
  let readError = null;
  if (pointKeys.length > 0) {
    try {
      raw = await readAllPoints(statusPoints, deviceId, modbus);
    } catch (err) {
      readError = err.message || String(err);
      raw = {};
    }
  }
  if (!hadDeviceConfig) {
    readError = "無可用控制器連線設定（deviceId 或 modbus.host/port）";
  }

  const uiStatus = deriveUiStatus(
    equipmentKind,
    raw,
    hadDeviceConfig,
    pointKeys,
  );

  if (syncAlerts) {
    try {
      await syncConnectivityAlert(
        Number(system.id),
        hadDeviceConfig,
        pointKeys,
        raw,
        readError,
      );
    } catch (alertErr) {
      statusLogger.warn("同步警報失敗（略過）", {
        systemId: Number(system.id),
        error: alertErr?.message || String(alertErr),
        module: "airCirculationStatusService",
      });
    }
  }

  return {
    zoneId: String(zone.id),
    zoneName: zone.name,
    locationId: String(location.id),
    locationName: location.name,
    systemId: String(system.id),
    equipmentKind,
    viewCategory,
    uiStatus,
    raw,
    ...(readError ? { error: readError } : {}),
  };
}

async function getStatusSnapshot(query = {}) {
  const zoneIdsFilter = Array.isArray(query.zoneIds) ? query.zoneIds : [];
  const syncAlerts = query.syncAlerts !== false;

  const result = await locationService.getZones({
    locationType: "air_circulation",
  });
  let zones = result.zones || [];
  if (zoneIdsFilter.length > 0) {
    const want = new Set(zoneIdsFilter.map((id) => String(id)));
    zones = zones.filter((z) => want.has(String(z.id)));
  }

  const triples = collectItemsFromZones(zones);
  const items = await Promise.all(
    triples.map(({ zone, location, system }) =>
      buildItem(zone, location, system, { syncAlerts }),
    ),
  );
  return { items };
}

async function getZoneStatusSnapshot(zoneId, query = {}) {
  const syncAlerts = query.syncAlerts !== false;
  const result = await locationService.getZoneById(zoneId, "air_circulation");
  const zone = result.zone;
  const triples = collectItemsFromZones([zone]);
  const items = await Promise.all(
    triples.map(({ zone: z, location, system }) =>
      buildItem(z, location, system, { syncAlerts }),
    ),
  );
  return { zoneId: String(zone.id), items };
}

module.exports = {
  getStatusSnapshot,
  getZoneStatusSnapshot,
};
