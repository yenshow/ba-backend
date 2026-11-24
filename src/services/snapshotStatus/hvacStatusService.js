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
const {
  resolveDeviceConfig,
  readAllStatusPoints,
  readSnapshotPoints,
  hasResolvableDeviceForPoints,
  deriveConnectivityUiStatus: deriveUiStatus,
} = require("./modbusSnapshotHelpers");
const systemAlert = require("../alerts/systemAlertHelper");
const alertService = require("../alerts/alertService");
const { loadActiveAlertSystemIdSet, mergeActiveAlertsIntoSnapshotItems } =
  systemAlert;
const logger = require("../../utils/logger");

const statusLogger = logger.createLogger("hvacStatusService");

async function readPrimaryBitPoint(modbus, conn) {
  const primary = pickPrimaryDiDoBitRead(modbus);
  if (!primary) return { ok: false, error: "未配置 DI/DO 點位" };
  if (!conn) return { ok: false, error: null };

  const [result] = await readSnapshotPoints([
    { ...conn, ...primary, length: 1 },
  ]);
  if (!result?.ok) {
    return { ok: false, error: result?.error || "無法讀取空調 DI/DO 狀態" };
  }
  return { ok: true, value: Boolean(result.data?.[0]) };
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

  const deviceConfig = await resolveDeviceConfig(deviceId, modbus);
  const hadDeviceConfig =
    Boolean(deviceConfig) ||
    (await hasResolvableDeviceForPoints(statusPoints, deviceId, modbus));

  let raw = {};
  let readError = null;
  try {
    if (pointKeys.length > 0) {
      raw = await readAllStatusPoints(statusPoints, deviceId, modbus, {
        numeric: true,
      });
    }
    if (modbus && typeof modbus === "object") {
      const on = await readPrimaryBitPoint(modbus, deviceConfig);
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

async function buildSnapshotItems(zones) {
  const triples = collectItemsFromZones(zones);
  const systemIds = triples
    .map((t) => Number(t.system?.id))
    .filter((n) => Number.isFinite(n));
  const items = await Promise.all(
    triples.map(({ zone, location, system }) =>
      buildItem(zone, location, system),
    ),
  );
  const activeAlertSystemIds = await loadActiveAlertSystemIdSet(
    alertService.ALERT_SOURCES.HVAC,
    systemIds,
  );
  return mergeActiveAlertsIntoSnapshotItems(items, activeAlertSystemIds);
}

async function getStatusSnapshot(query = {}) {
  const zoneIdsFilter = Array.isArray(query.zoneIds) ? query.zoneIds : [];

  const result = await locationService.getZones({ locationType: "hvac" });
  let zones = result.zones || [];
  if (zoneIdsFilter.length > 0) {
    const want = new Set(zoneIdsFilter.map((id) => String(id)));
    zones = zones.filter((z) => want.has(String(z.id)));
  }

  return { items: await buildSnapshotItems(zones) };
}

async function getZoneStatusSnapshot(zoneId) {
  const { zone } = await locationService.getZoneById(zoneId, "hvac");
  return {
    zoneId: String(zone.id),
    items: await buildSnapshotItems([zone]),
  };
}

module.exports = {
  getStatusSnapshot,
  getZoneStatusSnapshot,
};
