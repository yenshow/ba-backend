/**
 * Modbus 快照型子系統 statusService factory（排水／消防／電力／煙霧／求救／空氣循環）。
 * lighting／hvac 結構離群，不走此 factory。
 */

const locationService = require("../location/locationService");
const systemAlert = require("../alerts/systemAlertHelper");
const alertService = require("../alerts/alertService");
const {
  loadActiveAlertSystemIdSet,
  loadActiveRuleSemanticsBySystemId,
  mergeActiveAlertsIntoSnapshotItems,
} = systemAlert;
const {
  buildAlertSemanticsMetaBySystemId,
} = require("../monitoring/systemSnapshotStatusFields");
const {
  readAllStatusPoints,
  hasResolvableDeviceForPoints,
} = require("./modbusSnapshotHelpers");
const logger = require("../../utils/logger");

/**
 * @param {object} config
 * @param {string} config.systemType location_systems.system_type / locationType
 * @param {string} config.loggerName
 * @param {string} config.alertSource alertService.ALERT_SOURCES.*
 * @param {string} config.alertSyncKey syncLocationSnapshotReadResult 第一參數
 * @param {string} config.readErrorMessage
 * @param {(system: object) => { deviceId: *, modbus: *, equipmentKind: string, viewCategory: string, statusPoints: object }} config.resolveFields
 * @param {(raw: object, fields: object) => object} config.mergeRaw
 * @param {(rawMerged: object, hadDeviceConfig: boolean, pointKeys: string[], raw: object) => string} config.deriveUiStatus
 * @param {boolean} [config.useRuleSemantics=false]
 * @param {(triples: *, resolveFields: *) => object} [config.buildMetaBySystemId]
 * @param {(items: *, ruleSemantics: *) => *} [config.mergeRuleSemantics]
 * @param {boolean} [config.useAllSettled=false] 單系統失敗時以 fallback item 取代
 * @param {string} [config.fallbackEquipmentKind]
 * @param {string} [config.fallbackViewCategory]
 */
function createModbusSnapshotStatusService(config) {
  const {
    systemType,
    loggerName,
    alertSource,
    alertSyncKey,
    readErrorMessage,
    resolveFields,
    mergeRaw,
    deriveUiStatus,
    useRuleSemantics = false,
    buildMetaBySystemId = buildAlertSemanticsMetaBySystemId,
    mergeRuleSemantics,
    useAllSettled = false,
    fallbackEquipmentKind = "pump",
    fallbackViewCategory = systemType,
  } = config;

  const statusLogger = logger.createLogger(loggerName);

  function collectItemsFromZones(zones) {
    const items = [];
    for (const zone of zones) {
      const locs = zone.locations || [];
      for (const loc of locs) {
        const systems = loc.systems || [];
        for (const sys of systems) {
          if (sys.systemType === systemType) {
            items.push({ zone, location: loc, system: sys });
          }
        }
      }
    }
    return items;
  }

  async function syncConnectivityAlert(
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
      alertSyncKey,
      systemId,
      anyRead,
      readError || readErrorMessage,
    );
  }

  async function buildItem(zone, location, system) {
    const fields = resolveFields(system);
    const {
      deviceId,
      modbus,
      equipmentKind,
      viewCategory,
      statusPoints,
    } = fields;

    const pointKeys = Object.keys(statusPoints || {}).filter(
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
        raw = await readAllStatusPoints(statusPoints, deviceId, modbus);
      } catch (err) {
        readError = err.message || String(err);
        raw = {};
      }
    }

    const rawMerged = mergeRaw(raw, fields);
    const uiStatus = deriveUiStatus(
      rawMerged,
      hadDeviceConfig,
      pointKeys,
      raw,
    );

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
        module: loggerName,
      });
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

  function fallbackItem(zone, location, system, errorMsg) {
    const cfg = system.config || {};
    return {
      zoneId: String(zone.id),
      zoneName: zone.name,
      locationId: String(location.id),
      locationName: location.name,
      systemId: String(system.id),
      equipmentKind: cfg.equipmentKind || fallbackEquipmentKind,
      viewCategory: cfg.viewCategory || fallbackViewCategory,
      uiStatus: "warning",
      raw: {},
      error: errorMsg || "timeout",
    };
  }

  async function buildItemsWithAlerts(triples, zoneId = null) {
    const systemIds = triples
      .map((t) => Number(t.system?.id))
      .filter((n) => Number.isFinite(n));
    const activeAlertSystemIds = await loadActiveAlertSystemIdSet(
      alertSource,
      systemIds,
    );

    let ruleSemanticsBySystemId = null;
    if (useRuleSemantics && typeof mergeRuleSemantics === "function") {
      const metaBySystemId = buildMetaBySystemId(triples, resolveFields);
      ruleSemanticsBySystemId = await loadActiveRuleSemanticsBySystemId(
        alertSource,
        systemIds,
        metaBySystemId,
      );
    }

    let items;
    if (useAllSettled) {
      const settled = await Promise.allSettled(
        triples.map(({ zone, location, system }) =>
          buildItem(zone, location, system),
        ),
      );
      items = settled.map((r, idx) => {
        if (r.status === "fulfilled") return r.value;
        const t = triples[idx];
        return fallbackItem(
          t.zone,
          t.location,
          t.system,
          String(r.reason?.message || r.reason || "error"),
        );
      });
    } else {
      items = await Promise.all(
        triples.map(({ zone, location, system }) =>
          buildItem(zone, location, system),
        ),
      );
    }

    const mergedAlerts = mergeActiveAlertsIntoSnapshotItems(
      items,
      activeAlertSystemIds,
    );
    const finalItems =
      useRuleSemantics && typeof mergeRuleSemantics === "function"
        ? mergeRuleSemantics(mergedAlerts, ruleSemanticsBySystemId)
        : mergedAlerts;

    if (zoneId != null) {
      return { zoneId: String(zoneId), items: finalItems };
    }
    return { items: finalItems };
  }

  async function getStatusSnapshot(query = {}) {
    const zoneIdsFilter = query.zoneIds;
    const result = await locationService.getZones({ locationType: systemType });
    let zones = result.zones || [];

    if (zoneIdsFilter != null && zoneIdsFilter.length > 0) {
      const want = new Set(zoneIdsFilter.map((id) => String(id)));
      zones = zones.filter((z) => want.has(String(z.id)));
    }

    const triples = collectItemsFromZones(zones);
    return buildItemsWithAlerts(triples);
  }

  async function getZoneStatusSnapshot(zoneId) {
    const result = await locationService.getZoneById(zoneId, systemType);
    const zone = result.zone;
    const triples = collectItemsFromZones([zone]);
    return buildItemsWithAlerts(triples, zone.id);
  }

  return {
    getStatusSnapshot,
    getZoneStatusSnapshot,
  };
}

module.exports = {
  createModbusSnapshotStatusService,
};
