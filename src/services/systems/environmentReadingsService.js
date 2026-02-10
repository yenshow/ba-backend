/**
 * 環境讀數服務
 * 寫入 environment_readings 表（以 location 為中心）
 */

const db = require("../../database/db");

async function getReadingsForBackup(beforeDate) {
  const rows = await db.query(
    `SELECT er.recorded_at, er.data,
       l.name as location_name, z.name as zone_name, d.config as device_config
     FROM environment_readings er
     INNER JOIN locations l ON er.location_id = l.id
     INNER JOIN zones z ON l.zone_id = z.id
     LEFT JOIN devices d ON er.device_id = d.id
     WHERE er.recorded_at < $1
     ORDER BY er.recorded_at ASC`,
    [beforeDate]
  );
  return rows || [];
}

async function saveReading({ locationId, sourceId, deviceId, data }) {
  if (!locationId || !sourceId || !data || typeof data !== "object") {
    throw new Error("locationId, sourceId, data 為必填");
  }

  const recordedAt = new Date();
  const result = await db.query(
    `INSERT INTO environment_readings (location_id, source_id, recorded_at, data, device_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [locationId, sourceId, recordedAt, JSON.stringify(data), deviceId ?? null]
  );

  return result?.[0] ?? null;
}

module.exports = {
  saveReading,
  getReadingsForBackup,
};
