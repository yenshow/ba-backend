/**
 * 能源讀數寫入
 */
const db = require("../../database/db");

function roundData(data) {
  if (!data || typeof data !== "object") return data;
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value != null && typeof value === "number" && !Number.isNaN(value)) {
      out[key] = Math.round(value * 1000) / 1000;
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function saveReading({ deviceId, data, recordedAt = new Date() }) {
  const device_id = parseInt(deviceId, 10);
  if (!Number.isFinite(device_id) || !data || typeof data !== "object") {
    return null;
  }
  const rounded = roundData(data);
  const rows = await db.query(
    `INSERT INTO energy_readings (device_id, recorded_at, data)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, device_id, recorded_at, data`,
    [device_id, recordedAt, JSON.stringify(rounded)],
  );
  return rows?.[0] ?? null;
}

async function getLatestReadings(deviceIds) {
  const ids = (deviceIds || [])
    .map((id) => parseInt(id, 10))
    .filter((n) => Number.isFinite(n));
  if (ids.length === 0) return [];
  const rows = await db.query(
    `
    SELECT DISTINCT ON (er.device_id)
      er.id, er.device_id, er.recorded_at, er.data, d.name as device_name
    FROM energy_readings er
    INNER JOIN devices d ON d.id = er.device_id
    WHERE er.device_id = ANY($1::int[])
    ORDER BY er.device_id, er.recorded_at DESC
    `,
    [ids],
  );
  return rows || [];
}

async function listReadings({ deviceId, startTime, endTime, limit = 500, order = "desc" }) {
  const params = [];
  const where = [];
  if (deviceId != null) {
    params.push(parseInt(deviceId, 10));
    where.push(`er.device_id = $${params.length}`);
  }
  if (startTime) {
    params.push(new Date(startTime));
    where.push(`er.recorded_at >= $${params.length}`);
  }
  if (endTime) {
    params.push(new Date(endTime));
    where.push(`er.recorded_at < $${params.length}`);
  }
  const ord = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";
  params.push(Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000));
  const sql = `
    SELECT er.id, er.device_id, er.recorded_at, er.data, d.name as device_name
    FROM energy_readings er
    INNER JOIN devices d ON d.id = er.device_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY er.recorded_at ${ord}
    LIMIT $${params.length}
  `;
  return (await db.query(sql, params)) || [];
}

module.exports = {
  saveReading,
  getLatestReadings,
  listReadings,
};
