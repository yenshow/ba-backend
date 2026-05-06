/**
 * 照明系統：產生狀態快照（連線健康）
 * - 保留 legacy schema（system_config.modbus_config）
 * - 連線主點採 DI 優先，無 DI 才讀 DO
 */

const db = require("../../database/db");
const modbusBatchService = require("../devices/modbusBatchService");
const systemAlert = require("../alerts/systemAlertHelper");
const alertService = require("../alerts/alertService");
const { loadActiveAlertSystemIdSet, mergeActiveAlertsIntoSnapshotItems } =
  systemAlert;
const STATUS_CACHE_TTL_MS = Number(
  process.env.LIGHTING_STATUS_CACHE_TTL_MS || 1500,
);
const statusCache = new Map();

function parseDeviceConfig(row, modbusConfigRaw) {
  if (row.device_id && row.device_config) {
    const cfg =
      typeof row.device_config === "string"
        ? JSON.parse(row.device_config)
        : row.device_config;
    if (cfg?.host && cfg?.port !== undefined) {
      return {
        host: cfg.host,
        port: Number(cfg.port),
        unitId: Number(cfg.unitId || 1),
      };
    }
  }

  if (modbusConfigRaw?.host && modbusConfigRaw?.port !== undefined) {
    return {
      host: modbusConfigRaw.host,
      port: Number(modbusConfigRaw.port),
      unitId: Number(modbusConfigRaw.unitId || 1),
    };
  }

  return null;
}

function resolvePrimaryBitPoint(modbusConfigRaw) {
  const points = Array.isArray(modbusConfigRaw?.points)
    ? modbusConfigRaw.points
    : [];

  const diPoint = points.find(
    (point) =>
      String(point?.type || "").toLowerCase() === "di" &&
      Number.isFinite(Number(point.address)),
  );
  if (diPoint) {
    return { registerType: "discrete", address: Number(diPoint.address) };
  }

  const doPoint = points.find(
    (point) =>
      String(point?.type || "").toLowerCase() === "do" &&
      Number.isFinite(Number(point.address)),
  );
  if (doPoint) {
    return { registerType: "coil", address: Number(doPoint.address) };
  }

  if (Number.isFinite(Number(modbusConfigRaw?.diAddress))) {
    return {
      registerType: "discrete",
      address: Number(modbusConfigRaw.diAddress),
    };
  }
  if (Number.isFinite(Number(modbusConfigRaw?.doAddress))) {
    return { registerType: "coil", address: Number(modbusConfigRaw.doAddress) };
  }
  if (Number.isFinite(Number(modbusConfigRaw?.address))) {
    return { registerType: "coil", address: Number(modbusConfigRaw.address) };
  }

  return null;
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
      COALESCE(ls.system_config->>'device_id', ls.system_config->>'deviceId') AS device_id,
      ls.system_config->'modbus_config' AS modbus_config,
      d.config AS device_config
    FROM location_systems ls
    INNER JOIN locations l ON l.id = ls.location_id
    INNER JOIN zones z ON z.id = l.zone_id
    LEFT JOIN devices d
      ON COALESCE((ls.system_config->>'device_id')::integer, (ls.system_config->>'deviceId')::integer) = d.id
      AND d.status = 'active'
    WHERE ls.system_type = 'lighting'
      AND (
        ls.system_config->>'device_id' IS NOT NULL
        OR ls.system_config->>'deviceId' IS NOT NULL
      )
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

  try {
    const modbusConfigRaw =
      typeof row.modbus_config === "string"
        ? JSON.parse(row.modbus_config)
        : row.modbus_config;

    if (!modbusConfigRaw || Object.keys(modbusConfigRaw).length === 0) {
      const error = "配置為空";
      if (syncAlerts) {
        await systemAlert.syncLocationSnapshotReadResult(
          "lighting",
          systemId,
          false,
          error,
        );
      }
      return { ...baseItem, error };
    }

    const primary = resolvePrimaryBitPoint(modbusConfigRaw);
    if (!primary) {
      const error = "未配置 DI/DO 點位";
      if (syncAlerts) {
        await systemAlert.syncLocationSnapshotReadResult(
          "lighting",
          systemId,
          false,
          error,
        );
      }
      return { ...baseItem, error };
    }

    const deviceConfig = parseDeviceConfig(row, modbusConfigRaw);
    if (!deviceConfig) {
      const error = "配置不完整";
      if (syncAlerts) {
        await systemAlert.syncLocationSnapshotReadResult(
          "lighting",
          systemId,
          false,
          error,
        );
      }
      return { ...baseItem, deviceId: deviceId ?? undefined, error };
    }

    const results = await modbusBatchService.batchRead([
      {
        host: deviceConfig.host,
        port: deviceConfig.port,
        unitId: deviceConfig.unitId,
        registerType: primary.registerType,
        address: primary.address,
        length: 1,
        meta: { systemId },
      },
    ]);
    const first = results?.[0];
    if (!first || first.ok !== true) {
      throw new Error(first?.error || "無法讀取照明設備資料");
    }

    const isOn = Boolean(first.data?.[0]);
    if (syncAlerts) {
      await systemAlert.syncLocationSnapshotReadResult(
        "lighting",
        systemId,
        true,
      );
    }

    return {
      ...baseItem,
      deviceId: deviceId ?? undefined,
      uiStatus: "normal",
      raw: { isOn },
    };
  } catch (err) {
    const error = err?.message || "無法讀取照明設備資料";
    if (syncAlerts) {
      await systemAlert.syncLocationSnapshotReadResult(
        "lighting",
        systemId,
        false,
        error,
      );
    }
    return { ...baseItem, deviceId: deviceId ?? undefined, error };
  }
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
