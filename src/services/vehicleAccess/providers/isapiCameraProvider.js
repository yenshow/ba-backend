/**
 * ISAPI 車輛進出（vehicle_passageway_logs, data_source=isapi_camera）
 */
const db = require("../../../database/db");
const { getTodayTimeRange } = require("../../../utils/dateRangeUtils");
const { enrichLogsWithPerson } = require("../vehiclePlateEnrichment");

function mapRow(row) {
  const payload =
    typeof row.payload === "object"
      ? row.payload
      : row.payload
        ? JSON.parse(row.payload)
        : {};
  return {
    id: Number(row.id),
    lane_name: row.lane_name,
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
    anpr_line: row.anpr_line,
    data_source: "isapi_camera",
    device_id: row.device_id,
  };
}

function resolveTimeRange(options = {}) {
  const { startTime, endTime, timeRange } = options;
  if (startTime && endTime) {
    return { start: new Date(startTime), end: new Date(endTime) };
  }
  if (timeRange === "yesterday") {
    const today = getTodayTimeRange();
    const start = new Date(today.start);
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(today.end);
    end.setUTCDate(end.getUTCDate() - 1);
    return { start, end };
  }
  return getTodayTimeRange();
}

async function getSiteStats(siteId, _config, options = {}) {
  const { start, end } = resolveTimeRange(options);
  const baseParams = [siteId, start.toISOString(), end.toISOString()];
  const entryRows = await db.query(
    `SELECT COUNT(*)::int AS c FROM vehicle_passageway_logs
     WHERE location_id = ? AND data_source = 'isapi_camera'
       AND trigger_time >= ? AND trigger_time <= ?
       AND allow_result = 1 AND lane_type = 1`,
    baseParams,
  );
  const exitRows = await db.query(
    `SELECT COUNT(*)::int AS c FROM vehicle_passageway_logs
     WHERE location_id = ? AND data_source = 'isapi_camera'
       AND trigger_time >= ? AND trigger_time <= ?
       AND allow_result = 1 AND lane_type = 2`,
    baseParams,
  );
  const entryCount = Number(entryRows?.[0]?.c ?? 0);
  const exitCount = Number(exitRows?.[0]?.c ?? 0);
  return {
    entryCount,
    exitCount,
    currentCount: Math.max(0, entryCount - exitCount),
  };
}

async function getSiteLogs(siteId, _config, options = {}) {
  const { start, end } = resolveTimeRange(options);
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 10000);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const search = options.search ? String(options.search).trim() : "";

  let searchSql = "";
  const params = [siteId, start.toISOString(), end.toISOString()];
  if (search) {
    searchSql = ` AND (
      license_plate ILIKE ? OR owner_name ILIKE ? OR lane_name ILIKE ? OR anpr_line ILIKE ?
    )`;
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }

  const countRows = await db.query(
    `SELECT COUNT(*)::int AS c FROM vehicle_passageway_logs
     WHERE location_id = ? AND data_source = 'isapi_camera'
       AND trigger_time >= ? AND trigger_time <= ?${searchSql}`,
    params,
  );
  const total = Number(countRows?.[0]?.c ?? 0);

  const rows = await db.query(
    `SELECT * FROM vehicle_passageway_logs
     WHERE location_id = ? AND data_source = 'isapi_camera'
       AND trigger_time >= ? AND trigger_time <= ?${searchSql}
     ORDER BY trigger_time DESC
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
