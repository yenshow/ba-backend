/**
 * 門禁保全（access_security）查詢與手動語音廣播
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError, createApiError } = require("../../utils/apiErrors");
const { createLogger } = require("../../utils/logger");
const { alertIndoorDevice } = require("./sipInviteService");
const videoIntercomArmingService = require("./videoIntercomArmingService");
const operationalEventService = require("../operationalEvents/operationalEventService");

const logger = createLogger("accessSecurity");

const INTERCOM_MONITOR_SOURCES = Object.freeze([
  "access_security_ring",
  "alert_linkage",
]);

const UNCLASSIFIED_FLOOR = "未分類";
const FLOOR_NAME_RE = /^(\d+F|B\d+F?|R\d+F?|RF|G)(?:[-_]?(.*))?$/i;

const parseAccessSecurityUnitName = (name) => {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { floor: UNCLASSIFIED_FLOOR, unitName: "" };
  const match = FLOOR_NAME_RE.exec(trimmed);
  if (!match) return { floor: UNCLASSIFIED_FLOOR, unitName: trimmed };
  const floor = String(match[1] || "").trim().toUpperCase();
  const rest = String(match[2] || "").trim();
  return {
    floor: floor || UNCLASSIFIED_FLOOR,
    unitName: rest || trimmed,
  };
};

const resolveAccessSecurityFloor = (floorFromConfig, locationName) => {
  const fromConfig = String(floorFromConfig || "").trim();
  if (fromConfig && fromConfig !== UNCLASSIFIED_FLOOR) return fromConfig;
  return parseAccessSecurityUnitName(locationName).floor || UNCLASSIFIED_FLOOR;
};

const toPositiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function resolveLocationByIndoorDeviceId(deviceId) {
  const id = toPositiveInt(deviceId);
  if (!id) return null;

  const rows = await db.query(
    `
    SELECT ls.location_id, ls.id AS system_id, l.name AS location_name
    FROM location_systems ls
    INNER JOIN locations l ON l.id = ls.location_id
    WHERE ls.system_type = 'access_security'
      AND NULLIF(ls.system_config->>'indoor_device_id', '')::int = ?
    LIMIT 1
    `,
    [id],
  );
  const row = rows?.[0];
  if (!row?.location_id) return null;
  return {
    locationId: Number(row.location_id),
    systemId: row.system_id != null ? Number(row.system_id) : null,
    locationName: row.location_name || null,
  };
}

async function resolveLocationByVoipOrHost({ voipNumber, host } = {}) {
  const voip = String(voipNumber || "").trim();
  const ip = String(host || "").trim();
  if (!voip && !ip) return null;

  const rows = await db.query(
    `
    SELECT ls.location_id, ls.id AS system_id, l.name AS location_name
    FROM location_systems ls
    INNER JOIN locations l ON l.id = ls.location_id
    INNER JOIN devices d
      ON d.id = NULLIF(ls.system_config->>'indoor_device_id', '')::int
    WHERE ls.system_type = 'access_security'
      AND d.type_code = 'video_intercom'
      AND (
        (? <> '' AND (d.config->>'voipNumber') = ?)
        OR (? <> '' AND (d.config->>'host') = ?)
      )
    LIMIT 1
    `,
    [voip, voip, ip, ip],
  );
  const row = rows?.[0];
  if (!row?.location_id) return null;
  return {
    locationId: Number(row.location_id),
    systemId: row.system_id != null ? Number(row.system_id) : null,
    locationName: row.location_name || null,
  };
}

const parseConfig = (raw) => {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

async function getSites() {
  const rows = await db.query(
    `
    SELECT
      z.id AS zone_id,
      z.name AS zone_name,
      l.id AS location_id,
      l.name AS location_name,
      ls.id AS system_id,
      d.id AS indoor_device_id,
      d.name AS indoor_device_name,
      ls.system_config AS system_config
    FROM location_systems ls
    INNER JOIN locations l ON l.id = ls.location_id
    INNER JOIN zones z ON z.id = l.zone_id
    LEFT JOIN devices d
      ON d.id = NULLIF(ls.system_config->>'indoor_device_id', '')::int
    WHERE ls.system_type = 'access_security'
    ORDER BY z.sort_order NULLS LAST, z.id, l.sort_order NULLS LAST, l.id
    `,
  );

  const zoneMap = new Map();
  for (const row of rows || []) {
    const zoneId = Number(row.zone_id);
    if (!zoneMap.has(zoneId)) {
      zoneMap.set(zoneId, {
        id: zoneId,
        name: row.zone_name,
        manageDeviceId: null,
        locations: [],
      });
    }
    const systemCfg = parseConfig(row.system_config);
    const floor = resolveAccessSecurityFloor(systemCfg.floor, row.location_name);
    const manageId = Number(systemCfg.manage_device_id);
    const zone = zoneMap.get(zoneId);
    if (!zone) continue;
    if (
      zone.manageDeviceId == null &&
      Number.isFinite(manageId) &&
      manageId > 0
    ) {
      zone.manageDeviceId = manageId;
    }
    zone.locations.push({
      id: Number(row.location_id),
      name: row.location_name,
      systemId: Number(row.system_id),
      indoorDeviceId: row.indoor_device_id != null ? Number(row.indoor_device_id) : null,
      indoorDeviceName: row.indoor_device_name || null,
      floor: floor || null,
    });
  }

  return { zones: [...zoneMap.values()] };
}

async function getMainStations() {
  const armingStatus = videoIntercomArmingService.getStatus();
  const armedMap = new Map(
    (armingStatus.devices || []).map((d) => [Number(d.deviceId), d]),
  );

  const rows = await db.query(
    `
    SELECT id, name, config
    FROM devices
    WHERE type_code = 'video_intercom'
      AND COALESCE(config->>'unitType', '') = 'manage'
    ORDER BY id
    `,
  );

  const stations = (rows || []).map((row) => {
    const cfg = parseConfig(row.config);
    const armed = armedMap.get(Number(row.id));
    return {
      deviceId: Number(row.id),
      name: row.name,
      host: cfg.host || null,
      port: cfg.port != null ? Number(cfg.port) : 8000,
      armed: Boolean(armed),
      armingStatus: armed?.status || "stopped",
    };
  });

  return { stations };
}

async function resolveIndoorDeviceForLocation(locationId) {
  const lid = Number(locationId);
  if (!Number.isFinite(lid) || lid <= 0) {
    throwApiError(C.LOCATION_NOT_FOUND, "地點不存在");
  }

  const rows = await db.query(
    `
    SELECT ls.id AS system_id, ls.system_config, l.name AS location_name
    FROM location_systems ls
    INNER JOIN locations l ON l.id = ls.location_id
    WHERE ls.location_id = $1 AND ls.system_type = 'access_security'
    LIMIT 1
    `,
    [lid],
  );
  if (!rows?.length) {
    throw createApiError(
      C.LOCATION_SYSTEM_NOT_FOUND,
      "此地點尚未綁定門禁保全室內機",
    );
  }

  const cfg = parseConfig(rows[0].system_config);
  const indoorId = Number(cfg.indoor_device_id);
  if (!Number.isFinite(indoorId) || indoorId <= 0) {
    throw createApiError(C.LOCATION_DEVICE_NOT_FOUND, "地點未設定室內機");
  }

  const devices = await db.query(
    `SELECT id, name, type_code, config FROM devices WHERE id = $1`,
    [indoorId],
  );
  if (!devices?.length) {
    throw createApiError(C.LOCATION_DEVICE_NOT_FOUND, "室內機設備不存在");
  }

  return {
    locationId: lid,
    locationName: rows[0].location_name,
    systemId: Number(rows[0].system_id),
    device: devices[0],
  };
}

async function ringLocation(locationId, { actorUserId = null } = {}) {
  const { locationId: lid, locationName, systemId, device } =
    await resolveIndoorDeviceForLocation(locationId);

  let inviteResult;
  try {
    inviteResult = await alertIndoorDevice(device, {
      actorUserId,
      source: "access_security_ring",
    });
  } catch (error) {
    logger.warn("手動語音廣播失敗", {
      locationId: lid,
      deviceId: device.id,
      error: error?.message || String(error),
    });
    throw error;
  }

  await operationalEventService.recordEvent({
    source: "access_security_ring",
    event_kind: "intercom",
    location_id: lid,
    system_id: systemId,
    device_id: Number(device.id),
    message: inviteResult.played
      ? `手動語音廣播 ${locationName || lid}`
      : inviteResult.ok
        ? `手動振鈴 ${locationName || lid}`
        : `手動振鈴失敗 ${locationName || lid}`,
    actor_user_id: actorUserId,
    payload: {
      layer: 2,
      invite: inviteResult,
      fromAlertLinkage: false,
    },
  });

  return {
    locationId: lid,
    deviceId: Number(device.id),
    invite: inviteResult,
  };
}

async function getZoneLogsLatest(zoneId, { limit = 5 } = {}) {
  const zid = Number(zoneId);
  if (!Number.isFinite(zid) || zid <= 0) {
    throwApiError(C.LOCATION_NOT_FOUND, "區域不存在");
  }

  const zoneRows = await db.query(`SELECT id FROM zones WHERE id = $1`, [zid]);
  if (!zoneRows?.length) {
    throwApiError(C.LOCATION_NOT_FOUND, "區域不存在");
  }

  const lim = Math.min(Math.max(Number(limit) || 5, 1), 50);
  const sources = INTERCOM_MONITOR_SOURCES;

  const logs = await db.query(
    `
    SELECT
      oe.id, oe.created_at, oe.source, oe.event_kind,
      oe.location_id, oe.system_id, oe.device_id,
      oe.message, oe.payload,
      d.name AS device_name,
      l.name AS location_name,
      z.name AS zone_name
    FROM operational_events oe
    LEFT JOIN devices d ON oe.device_id = d.id
    LEFT JOIN locations l ON oe.location_id = l.id
    LEFT JOIN zones z ON l.zone_id = z.id
    WHERE oe.event_kind = 'intercom'
      AND oe.source IN (?, ?)
      AND (
        oe.location_id IN (
          SELECT l2.id
          FROM locations l2
          INNER JOIN location_systems ls
            ON ls.location_id = l2.id AND ls.system_type = 'access_security'
          WHERE l2.zone_id = ?
        )
        OR oe.system_id IN (
          SELECT ls.id
          FROM location_systems ls
          INNER JOIN locations l2 ON l2.id = ls.location_id
          WHERE l2.zone_id = ? AND ls.system_type = 'access_security'
        )
        OR oe.device_id IN (
          SELECT NULLIF(ls.system_config->>'indoor_device_id', '')::int
          FROM location_systems ls
          INNER JOIN locations l2 ON l2.id = ls.location_id
          WHERE l2.zone_id = ? AND ls.system_type = 'access_security'
        )
      )
    ORDER BY oe.created_at DESC, oe.id DESC
    LIMIT ?
    `,
    [sources[0], sources[1], zid, zid, zid, lim],
  );

  return { logs: logs || [] };
}

module.exports = {
  getSites,
  getMainStations,
  resolveIndoorDeviceForLocation,
  ringLocation,
  getZoneLogsLatest,
  resolveLocationByIndoorDeviceId,
  resolveLocationByVoipOrHost,
};
