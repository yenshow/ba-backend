/**
 * ISAPI 車輛進出（vehicle_passageway_logs, data_source=isapi_camera）
 */
const db = require("../../../database/db");
const { enrichLogsWithPerson } = require("../vehiclePlateEnrichment");
const { normalizePlate } = require("../../../utils/vehiclePlateUtils");
const { computeTransitionStats } = require("../../entryExit/stats");
const {
  resolveStatsTimeRange,
  ENTRY_EXIT_MAX_RECORDS,
} = require("../../entryExit/resolveTimeOptions");
const { normalizeVehicleDirection } = require("../normalizeVehicleDirection");

/** 顯示用車道名稱：devices.name（寫入時已用 devices.name；此處不做舊「線別 N」相容） */
function resolveIsapiLaneDisplayName(row) {
  const deviceName = row.device_name ? String(row.device_name).trim() : "";
  const laneName = row.lane_name != null ? String(row.lane_name).trim() : "";
  return deviceName || laneName || null;
}

function mapRow(row) {
  return {
    id: Number(row.id),
    lane_name: resolveIsapiLaneDisplayName(row),
    lane_id: row.lane_id,
    allow_result: row.allow_result != null ? Number(row.allow_result) : null,
    lane_type: row.lane_type != null ? Number(row.lane_type) : null,
    trigger_time:
      row.trigger_time instanceof Date
        ? row.trigger_time.toISOString()
        : row.trigger_time,
    license_plate: row.license_plate,
    owner_name: row.owner_name,
    plate_license_image_url: row.picture_path,
    vehicle_list_id: row.vehicle_list_id ?? -1,
    vehicle_list_name: row.vehicle_list_name ?? "",
    organization_id: null,
    person_group_name: null,
    vehicle_category: 0,
    is_blacklist: false,
    data_source: "isapi_camera",
    device_id: row.device_id,
  };
}

async function getSiteStats(siteId, _config, options = {}) {
  const { start, end } = resolveStatsTimeRange(options);
  const rows = await db.query(
    `SELECT license_plate, allow_result, lane_type, trigger_time
     FROM vehicle_passageway_logs
     WHERE location_id = ? AND data_source = 'isapi_camera'
       AND trigger_time >= ? AND trigger_time <= ?
       AND allow_result = 1 AND lane_type IN (1, 2)
     ORDER BY trigger_time ASC`,
    [siteId, start.toISOString(), end.toISOString()],
  );
  return computeTransitionStats(rows || [], {
    getKey: (r) => normalizePlate(r.license_plate),
    getDirection: normalizeVehicleDirection,
    getTime: (r) => r.trigger_time,
    sortByTime: false,
  });
}

async function getSiteLogs(siteId, _config, options = {}) {
  const useSinceOnly = Boolean(options.useSinceOnly && options.since);
  const { start, end } = useSinceOnly
    ? { start: new Date(options.since), end: new Date() }
    : resolveStatsTimeRange(options);
  const timeCompareSql = useSinceOnly
    ? "vpl.trigger_time > ?"
    : "vpl.trigger_time >= ? AND vpl.trigger_time <= ?";
  const limit = Math.min(
    Math.max(Number(options.limit) || 50, 1),
    ENTRY_EXIT_MAX_RECORDS,
  );
  const offset = Math.max(Number(options.offset) || 0, 0);
  const search = options.search ? String(options.search).trim() : "";

  let searchSql = "";
  const params = useSinceOnly
    ? [siteId, start.toISOString()]
    : [siteId, start.toISOString(), end.toISOString()];
  if (search) {
    searchSql = ` AND (
      vpl.license_plate ILIKE ? OR vpl.owner_name ILIKE ? OR vpl.lane_name ILIKE ? OR d.name ILIKE ?
    )`;
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }

  const countRows = await db.query(
    `SELECT COUNT(*)::int AS c FROM vehicle_passageway_logs vpl
     LEFT JOIN devices d ON vpl.device_id = d.id
     WHERE vpl.location_id = ? AND vpl.data_source = 'isapi_camera'
       AND ${timeCompareSql}${searchSql}`,
    params,
  );
  const total = Number(countRows?.[0]?.c ?? 0);

  const rows = await db.query(
    `SELECT vpl.*, d.name AS device_name
     FROM vehicle_passageway_logs vpl
     LEFT JOIN devices d ON vpl.device_id = d.id
     WHERE vpl.location_id = ? AND vpl.data_source = 'isapi_camera'
       AND ${timeCompareSql}${searchSql}
     ORDER BY vpl.trigger_time DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  let logs = (rows || []).map(mapRow);
  logs = await enrichLogsWithPerson(logs);
  return { logs, total };
}

module.exports = {
  getSiteStats,
  getSiteLogs,
};
