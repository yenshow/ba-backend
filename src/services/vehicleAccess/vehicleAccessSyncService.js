/**
 * 車輛進出過車記錄同步服務
 * 將外部 vehiclebiz.passageway_log_data 同步至主庫 vehicle_passageway_logs，供備份使用
 */

const externalDb = require("../../database/externalDb");
const db = require("../../database/db");
const getLocationService = () => require("../location/locationService");
const { vehicleAccess: yscpVehicleFeature } = require("../../utils/yscpSystemFeature");

/**
 * 取得 lane_id -> { zoneName, locationName, locationId } 映射
 */
async function getLaneIdToLocationMap() {
  const result = await getLocationService().getZones({ locationType: "vehicle_access" });
  const map = new Map();

  for (const zone of result.zones || []) {
    const zoneName = zone.name ?? "";
    for (const loc of zone.locations || []) {
      const sys = (loc.systems || []).find((s) => s.systemType === "vehicle_access");
      const entryLaneId = sys?.config?.entryLaneId;
      const exitLaneId = sys?.config?.exitLaneId;
      const locationName = loc.name ?? "";
      const locationId = loc.id != null ? Number(loc.id) : null;

      const info = { zoneName, locationName, locationId };
      if (entryLaneId != null) map.set(Number(entryLaneId), info);
      if (exitLaneId != null) map.set(Number(exitLaneId), info);
    }
  }

  return map;
}

/**
 * 同步指定時間範圍的過車記錄
 * @param {Date} start - 開始時間（含）
 * @param {Date} end - 結束時間（含）
 * @returns {Promise<{ synced: number }>}
 */
async function syncRecords(start, end) {
  if (!yscpVehicleFeature.isEnabled()) return { synced: 0 };
  const laneMap = await getLaneIdToLocationMap();

  const sql = `
    SELECT
      p.id AS external_id,
      p.trigger_time,
      p.lane_id,
      p.lane_name,
      p.license_plate,
      p.owner_name,
      p.allow_result,
      li.lane_type,
      p.vehicle_list_id,
      p.vehicle_list_name
    FROM vehiclebiz.passageway_log_data p
    LEFT JOIN vehiclebiz.lane_info li ON p.lane_id = li.id
    WHERE p.trigger_time >= $1 AND p.trigger_time <= $2
    ORDER BY p.trigger_time ASC
  `;

  const rows = await externalDb.query(sql, [start.toISOString(), end.toISOString()]);
  if (!rows || rows.length === 0) {
    return { synced: 0 };
  }

  const params = [];
  const values = [];
  let idx = 1;

  for (const row of rows) {
    const laneId = row.lane_id != null ? Number(row.lane_id) : null;
    const info = laneId != null ? laneMap.get(laneId) : null;
    const zoneName = info?.zoneName ?? "";
    const locationName = info?.locationName ?? "";
    const locationId = info?.locationId ?? null;

    values.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    params.push(
      row.external_id ?? null,
      row.trigger_time,
      row.lane_id ?? null,
      (row.lane_name ?? "").trim() || null,
      (row.license_plate ?? "").trim() || null,
      (row.owner_name ?? "").trim() || null,
      row.allow_result != null ? Number(row.allow_result) : null,
      row.lane_type != null ? Number(row.lane_type) : null,
      row.vehicle_list_id != null ? Number(row.vehicle_list_id) : null,
      (row.vehicle_list_name ?? "").trim() || null,
      zoneName,
      locationName,
      locationId,
      "yscp",
    );
  }

  const insertSql = `
    INSERT INTO vehicle_passageway_logs (
      external_id, trigger_time, lane_id, lane_name, license_plate, owner_name,
      allow_result, lane_type, vehicle_list_id, vehicle_list_name,
      zone_name, location_name, location_id, data_source
    )
    VALUES ${values.join(", ")}
    ON CONFLICT (external_id) DO NOTHING
  `;

  const result = await db.query(insertSql, params);
  const inserted = result?.rowCount ?? 0;

  return { synced: inserted };
}

/**
 * 同步「昨日」的記錄（供每日排程呼叫）
 * @returns {Promise<{ synced: number }>}
 */
async function syncYesterday() {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0)
  );
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 1,
      23,
      59,
      59,
      999
    )
  );
  return syncRecords(start, end);
}

/**
 * 同步指定天數前的單日記錄
 * @param {number} daysAgo - 幾天前（1 = 昨天）
 * @returns {Promise<{ synced: number }>}
 */
async function syncDayAgo(daysAgo) {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 0, 0, 0, 0)
  );
  const start = d;
  const end = new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
  return syncRecords(start, end);
}

module.exports = {
  getLaneIdToLocationMap,
  syncRecords,
  syncYesterday,
  syncDayAgo,
};
