/**
 * 車輛在場狀態（vehicle_presence）
 */
const db = require("../../database/db");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { normalizeVehicleDirection } = require("./normalizeVehicleDirection");
const websocketService = require("../websocket/websocketService");

async function upsertPresenceFromPassage(locationId, plateRaw, laneTypeRecord, eventTime) {
  const locationIdNum = Number(locationId);
  if (!Number.isFinite(locationIdNum)) return;

  const plate = normalizePlate(plateRaw);
  if (!plate) return;

  const direction = normalizeVehicleDirection(laneTypeRecord);
  if (direction !== "entry" && direction !== "exit") return;

  const isPresent = direction === "entry";
  const eventIso =
    eventTime instanceof Date
      ? eventTime.toISOString()
      : String(eventTime || new Date().toISOString());

  await db.query(
    `INSERT INTO vehicle_presence (
      location_id, plate_normalized, is_present, last_event_time, last_lane_type, updated_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (location_id, plate_normalized)
    DO UPDATE SET
      is_present = EXCLUDED.is_present,
      last_event_time = EXCLUDED.last_event_time,
      last_lane_type = EXCLUDED.last_lane_type,
      updated_at = CURRENT_TIMESTAMP`,
    [
      locationIdNum,
      plate,
      isPresent,
      eventIso,
      laneTypeRecord?.lane_type != null
        ? Number(laneTypeRecord.lane_type)
        : null,
    ],
  );
}

async function getPresenceCount(locationId) {
  const rows = await db.query(
    `SELECT COUNT(*)::int AS c FROM vehicle_presence
     WHERE location_id = ? AND is_present = true`,
    [locationId],
  );
  return Number(rows?.[0]?.c ?? 0);
}

async function getPresentPlates(locationId) {
  const rows = await db.query(
    `SELECT plate_normalized FROM vehicle_presence
     WHERE location_id = ? AND is_present = true
     ORDER BY plate_normalized ASC`,
    [locationId],
  );
  return (rows || []).map((r) => String(r.plate_normalized));
}

async function resetPresence(locationId) {
  await db.query(`DELETE FROM vehicle_presence WHERE location_id = ?`, [
    locationId,
  ]);
  websocketService.emitVehicleAccessIsapiEvent({
    type: "presence_reset",
    locationId: Number(locationId),
  });
}

module.exports = {
  upsertPresenceFromPassage,
  getPresenceCount,
  getPresentPlates,
  resetPresence,
};
