/**
 * 車輛在場狀態（vehicle_presence）
 */
const db = require("../../database/db");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { normalizeVehicleDirection } = require("./vehicleAccessHelpers");
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

/**
 * 以 session 內放行過車紀錄重建在場（與 transition「最後為 entry」口徑一致）。
 * 用於清除無對應放行 log 的孤兒 presence；不依拒絕／陌生事件變更在場。
 *
 * @param {number} locationId
 * @param {Array<{ license_plate?: string, allow_result?: number, lane_type?: number|null, trigger_time?: * }>} rows
 *   呼叫端應已篩 `allow_result = 1` 且依時間升序
 * @returns {Promise<{ presentPlates: string[] }>}
 */
async function syncPresenceFromReleasedRows(locationId, rows) {
  const locationIdNum = Number(locationId);
  if (!Number.isFinite(locationIdNum)) return { presentPlates: [] };

  /** @type {Map<string, { dir: 'entry'|'exit', time: *, laneType: number|null }>} */
  const lastByPlate = new Map();
  for (const row of rows || []) {
    const plate = normalizePlate(row.license_plate);
    if (!plate) continue;
    const dir = normalizeVehicleDirection(row);
    if (dir !== "entry" && dir !== "exit") continue;
    const prev = lastByPlate.get(plate);
    if (prev === undefined && dir === "exit") continue;
    lastByPlate.set(plate, {
      dir,
      time: row.trigger_time,
      laneType: row.lane_type != null ? Number(row.lane_type) : null,
    });
  }

  /** @type {{ plate: string, eventTime: *, laneType: number|null }[]} */
  const presentEntries = [];
  for (const [plate, state] of lastByPlate) {
    if (state.dir !== "entry") continue;
    presentEntries.push({
      plate,
      eventTime: state.time,
      laneType: state.laneType,
    });
  }

  await db.transaction(async (query) => {
    await query(`DELETE FROM vehicle_presence WHERE location_id = ?`, [
      locationIdNum,
    ]);
    for (const entry of presentEntries) {
      const eventIso =
        entry.eventTime instanceof Date
          ? entry.eventTime.toISOString()
          : String(entry.eventTime || new Date().toISOString());
      await query(
        `INSERT INTO vehicle_presence (
          location_id, plate_normalized, is_present, last_event_time, last_lane_type, updated_at
        ) VALUES (?, ?, true, ?, ?, CURRENT_TIMESTAMP)`,
        [locationIdNum, entry.plate, eventIso, entry.laneType],
      );
    }
  });

  return {
    presentPlates: presentEntries.map((e) => e.plate).sort((a, b) => a.localeCompare(b)),
  };
}

module.exports = {
  upsertPresenceFromPassage,
  getPresenceCount,
  getPresentPlates,
  resetPresence,
  syncPresenceFromReleasedRows,
};
