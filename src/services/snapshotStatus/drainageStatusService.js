/**
 * 衛生排水：依 location_systems 設定讀取 Modbus 並合成 uiStatus（單點失敗不影響其他設備）
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
const {
  loadActiveAlertSystemIdSet,
  loadActiveRuleSemanticsBySystemId,
  mergeActiveAlertsIntoSnapshotItems,
  mergeRuleSemanticsIntoDrainageFireSnapshotItems,
} = systemAlert;
const logger = require("../../utils/logger");
const {
  mergeDrainageFirePumpSnapshotRaw,
  mergeDrainageFireTankSnapshotRaw,
} = require("../monitoring/systemSnapshotMonitorFactory");
const {
  resolveLocationSystemStatusFields,
  buildAlertSemanticsMetaBySystemId,
  deriveSnapshotAggregateRunningUiStatus,
} = require("../monitoring/systemSnapshotStatusFields");

const statusLogger = logger.createLogger("drainageStatusService");

const DRAINAGE_STATUS_FIELD_DEFAULTS = {
  equipmentKind: "pump",
  viewCategory: "drainage",
};

/**
 * 讀取 statusPoints 物件中每個鍵對應的點位（可每點獨立 deviceId），失敗的鍵略過
 */
async function readAllPoints(statusPoints, cfgDeviceId, cfgModbus) {
  const raw = {};
  if (!statusPoints || typeof statusPoints !== "object") {
    return raw;
  }

  // 以 batch-read 讀取：同 device+registerType 自動合併範圍，且共用後端 snapshot cache
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

function resolveDrainageSystemFields(system) {
  return resolveLocationSystemStatusFields(
    system,
    DRAINAGE_STATUS_FIELD_DEFAULTS,
  );
}

async function syncDrainageConnectivityAlert(
  systemId,
  hadDeviceConfig,
  pointKeys,
  raw,
  readError,
) {
  if (!hadDeviceConfig || !pointKeys || pointKeys.length === 0) {
    return;
  }

  const anyRead = pointKeys.some(
    (k) => raw[k] !== undefined && raw[k] !== null,
  );
  await systemAlert.syncLocationSnapshotReadResult(
    "drainage",
    systemId,
    anyRead,
    readError || "無法讀取排水設備資料",
  );
}

async function buildItemForDrainageSystem(
  zone,
  location,
  system,
  options = {},
) {
  const { syncAlerts = true } = options || {};
  const {
    deviceId,
    modbus,
    equipmentKind,
    viewCategory,
    statusPoints,
  } = resolveDrainageSystemFields(system);

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

  const rawMerged =
    equipmentKind === "tank"
      ? mergeDrainageFireTankSnapshotRaw(raw)
      : mergeDrainageFirePumpSnapshotRaw(raw);

  const uiStatus = deriveSnapshotAggregateRunningUiStatus(
    rawMerged,
    hadDeviceConfig,
    pointKeys,
    raw,
  );

  if (syncAlerts) {
    try {
      await syncDrainageConnectivityAlert(
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
        module: "drainageStatusService",
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

function collectDrainageItemsFromZones(zones) {
  const items = [];
  for (const zone of zones) {
    const locs = zone.locations || [];
    for (const loc of locs) {
      const systems = loc.systems || [];
      for (const sys of systems) {
        if (sys.systemType === "drainage") {
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
  const result = await locationService.getZones({ locationType: "drainage" });
  let zones = result.zones || [];

  if (zoneIdsFilter != null && zoneIdsFilter.length > 0) {
    const want = new Set(zoneIdsFilter.map((id) => String(id)));
    zones = zones.filter((z) => want.has(String(z.id)));
  }

  const triples = collectDrainageItemsFromZones(zones);
  const systemIds = triples
    .map((t) => Number(t.system?.id))
    .filter((n) => Number.isFinite(n));
  const activeAlertSystemIds = await loadActiveAlertSystemIdSet(
    alertService.ALERT_SOURCES.DRAINAGE,
    systemIds,
  );
  const metaBySystemId = buildAlertSemanticsMetaBySystemId(
    triples,
    resolveDrainageSystemFields,
  );
  const ruleSemanticsBySystemId = await loadActiveRuleSemanticsBySystemId(
    alertService.ALERT_SOURCES.DRAINAGE,
    systemIds,
    metaBySystemId,
  );
  const items = await Promise.all(
    triples.map(({ zone, location, system }) =>
      buildItemForDrainageSystem(zone, location, system, { syncAlerts }),
    ),
  );

  const mergedAlerts = mergeActiveAlertsIntoSnapshotItems(
    items,
    activeAlertSystemIds,
  );
  return {
    items: mergeRuleSemanticsIntoDrainageFireSnapshotItems(
      mergedAlerts,
      ruleSemanticsBySystemId,
    ),
  };
}

async function getZoneStatusSnapshot(zoneId, query = {}) {
  const syncAlerts = query.syncAlerts !== false;
  const result = await locationService.getZoneById(zoneId, "drainage");
  const zone = result.zone;
  const triples = collectDrainageItemsFromZones([zone]);
  const systemIds = triples
    .map((t) => Number(t.system?.id))
    .filter((n) => Number.isFinite(n));
  const activeAlertSystemIds = await loadActiveAlertSystemIdSet(
    alertService.ALERT_SOURCES.DRAINAGE,
    systemIds,
  );
  const metaBySystemId = buildAlertSemanticsMetaBySystemId(
    triples,
    resolveDrainageSystemFields,
  );
  const ruleSemanticsBySystemId = await loadActiveRuleSemanticsBySystemId(
    alertService.ALERT_SOURCES.DRAINAGE,
    systemIds,
    metaBySystemId,
  );
  const items = await Promise.all(
    triples.map(({ zone: z, location, system }) =>
      buildItemForDrainageSystem(z, location, system, { syncAlerts }),
    ),
  );
  const mergedAlerts = mergeActiveAlertsIntoSnapshotItems(
    items,
    activeAlertSystemIds,
  );
  return {
    zoneId: String(zone.id),
    items: mergeRuleSemanticsIntoDrainageFireSnapshotItems(
      mergedAlerts,
      ruleSemanticsBySystemId,
    ),
  };
}

module.exports = {
  getStatusSnapshot,
  getZoneStatusSnapshot,
};
