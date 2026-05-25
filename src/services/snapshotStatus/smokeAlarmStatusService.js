/**
 * 煙霧警報：依 location_systems 設定讀取 Modbus（DI/DO/Registers）並合成 uiStatus
 * API `raw`：觸發（含舊鍵與 fault）合併為 **running**；fault 不再單獨表示「異常」層級
 */

const locationService = require("../location/locationService");
const modbusBatchService = require("../devices/modbusBatchService");
const {
  ALLOWED_REGISTER_TYPES,
  resolveDeviceConfig,
  normalizeRegisterType,
} = require("./modbusSnapshotHelpers");
const systemAlert = require("../alerts/systemAlertHelper");
const alertService = require("../alerts/alertService");
const { loadActiveAlertSystemIdSet, mergeActiveAlertsIntoSnapshotItems } =
  systemAlert;
const logger = require("../../utils/logger");
const {
  normalizeSmokeEmergencySnapshotRaw,
} = require("../monitoring/systemSnapshotMonitorFactory");

const statusLogger = logger.createLogger("smokeAlarmStatusService");

const STATUS_SNAPSHOT_ITEM_TIMEOUT_MS = 4000;

async function readAllPoints(statusPoints, cfgDeviceId, cfgModbus) {
  const raw = {};
  if (!statusPoints || typeof statusPoints !== "object") {
    return raw;
  }

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

  if (reqs.length === 0) {
    return raw;
  }

  const results = await modbusBatchService.batchRead(reqs);
  for (const r of results) {
    const k = r?.meta?.pointKey;
    if (!k) continue;
    if (r.ok) {
      const v = r.data?.[0];
      if (typeof v === "boolean") raw[k] = v;
      else if (typeof v === "number") raw[k] = v !== 0;
      else raw[k] = Boolean(v);
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

/**
 * - **alarm**：raw.running === true
 * - **normal**：已連線且有讀值、未觸發
 * - **warning**：未連線、無點位或讀值全失敗
 */
function deriveSmokeAlarmUiStatus(
  rawMerged,
  hadDeviceConfig,
  pointKeysConfigured,
  rawRead,
) {
  if (!hadDeviceConfig) return "warning";
  if (!pointKeysConfigured || pointKeysConfigured.length === 0) {
    return "warning";
  }

  const src = rawRead && typeof rawRead === "object" ? rawRead : rawMerged;
  const anyRead = pointKeysConfigured.some(
    (k) => src[k] !== undefined && src[k] !== null,
  );
  if (!anyRead) return "warning";

  if (rawMerged.running === true) {
    return "alarm";
  }
  return "normal";
}

async function syncSmokeAlarmConnectivityAlert(
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
    "smoke_alarm",
    systemId,
    anyRead,
    readError || "無法讀取煙霧警報設備資料",
  );
}

async function buildItemForSmokeAlarmSystem(
  zone,
  location,
  system,
  options = {},
) {
  const { syncAlerts = true } = options || {};
  const cfg = system.config || {};
  const deviceId = cfg.deviceId;
  const modbus = cfg.modbus;
  const equipmentKind = cfg.equipmentKind || "detector";
  const viewCategory = cfg.viewCategory || "smoke";
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

  const rawMerged = normalizeSmokeEmergencySnapshotRaw(raw);
  const uiStatus = deriveSmokeAlarmUiStatus(
    rawMerged,
    hadDeviceConfig,
    pointKeys,
    raw,
  );

  if (syncAlerts) {
    try {
      await syncSmokeAlarmConnectivityAlert(
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
        module: "smokeAlarmStatusService",
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
    raw: rawMerged,
    ...(readError ? { error: readError } : {}),
  };
}

function smokeAlarmFallbackItem(zone, location, system, errorMsg) {
  const cfg = system.config || {};
  return {
    zoneId: String(zone.id),
    zoneName: zone.name,
    locationId: String(location.id),
    locationName: location.name,
    systemId: String(system.id),
    equipmentKind: cfg.equipmentKind || "detector",
    viewCategory: cfg.viewCategory || "smoke",
    uiStatus: "warning",
    raw: {},
    error: errorMsg || "timeout",
  };
}

async function buildSmokeAlarmItemWithTimeout(zone, location, system, options) {
  try {
    return await Promise.race([
      buildItemForSmokeAlarmSystem(zone, location, system, options),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("STATUS_SNAPSHOT_ITEM_TIMEOUT")),
          STATUS_SNAPSHOT_ITEM_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    const msg =
      String(err?.message || err) === "STATUS_SNAPSHOT_ITEM_TIMEOUT"
        ? "timeout"
        : String(err?.message || err);
    return smokeAlarmFallbackItem(zone, location, system, msg);
  }
}

function collectSmokeAlarmItemsFromZones(zones) {
  const items = [];
  for (const zone of zones) {
    const locs = zone.locations || [];
    for (const loc of locs) {
      const systems = loc.systems || [];
      for (const sys of systems) {
        if (sys.systemType === "smoke_alarm") {
          items.push({ zone, location: loc, system: sys });
        }
      }
    }
  }
  return items;
}

async function getStatusSnapshot(query = {}) {
  const zoneIdsFilter = query.zoneIds;
  const syncAlerts = query.syncAlerts !== false;
  const result = await locationService.getZones({
    locationType: "smoke_alarm",
  });
  let zones = result.zones || [];

  if (zoneIdsFilter != null && zoneIdsFilter.length > 0) {
    const want = new Set(zoneIdsFilter.map((id) => String(id)));
    zones = zones.filter((z) => want.has(String(z.id)));
  }

  const triples = collectSmokeAlarmItemsFromZones(zones);
  const systemIds = triples
    .map((t) => Number(t.system?.id))
    .filter((n) => Number.isFinite(n));
  const activeAlertSystemIds = await loadActiveAlertSystemIdSet(
    alertService.ALERT_SOURCES.SMOKE_ALARM,
    systemIds,
  );
  const settled = await Promise.allSettled(
    triples.map(({ zone, location, system }) =>
      buildSmokeAlarmItemWithTimeout(zone, location, system, { syncAlerts }),
    ),
  );
  const items = settled.map((r, idx) => {
    if (r.status === "fulfilled") return r.value;
    const t = triples[idx];
    return smokeAlarmFallbackItem(
      t.zone,
      t.location,
      t.system,
      String(r.reason?.message || r.reason || "error"),
    );
  });

  return {
    items: mergeActiveAlertsIntoSnapshotItems(items, activeAlertSystemIds),
  };
}

async function getZoneStatusSnapshot(zoneId, query = {}) {
  const syncAlerts = query.syncAlerts !== false;
  const result = await locationService.getZoneById(zoneId, "smoke_alarm");
  const zone = result.zone;
  const triples = collectSmokeAlarmItemsFromZones([zone]);
  const systemIds = triples
    .map((t) => Number(t.system?.id))
    .filter((n) => Number.isFinite(n));
  const activeAlertSystemIds = await loadActiveAlertSystemIdSet(
    alertService.ALERT_SOURCES.SMOKE_ALARM,
    systemIds,
  );
  const settled = await Promise.allSettled(
    triples.map(({ zone: z, location, system }) =>
      buildSmokeAlarmItemWithTimeout(z, location, system, { syncAlerts }),
    ),
  );
  const items = settled.map((r, idx) => {
    if (r.status === "fulfilled") return r.value;
    const t = triples[idx];
    return smokeAlarmFallbackItem(
      t.zone,
      t.location,
      t.system,
      String(r.reason?.message || r.reason || "error"),
    );
  });
  return {
    zoneId: String(zone.id),
    items: mergeActiveAlertsIntoSnapshotItems(items, activeAlertSystemIds),
  };
}

module.exports = {
  getStatusSnapshot,
  getZoneStatusSnapshot,
};
