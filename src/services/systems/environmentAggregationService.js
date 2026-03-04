/**
 * 環境讀數彙總服務
 * 由 raw 計算時／日／月平均，寫入 environment_readings_aggregated
 * 設計：docs/ENVIRONMENT_DATA_DESIGN.md
 */

const db = require("../../database/db");

async function getEnvironmentLocationIds() {
  const rows = await db.query(`
    SELECT l.id FROM locations l
    INNER JOIN location_systems ls ON l.id = ls.location_id
    WHERE ls.system_type = 'environment'
      AND (
        jsonb_array_length(COALESCE(ls.system_config->'device_ids', '[]'::jsonb)) > 0
        OR ((ls.system_config->>'device_id') IS NOT NULL AND (ls.system_config->>'device_id') != '')
      )
  `);
  return (rows || []).map((r) => r.id);
}

function computeAverageData(rows) {
  if (!rows || rows.length === 0) return {};
  const sums = {};
  const counts = {};
  for (const row of rows) {
    const data = typeof row.data === "object" ? row.data : (row.data ? JSON.parse(row.data) : {});
    for (const [key, value] of Object.entries(data)) {
      if (value != null && typeof value === "number" && !Number.isNaN(value)) {
        sums[key] = (sums[key] || 0) + value;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }
  const result = {};
  for (const key of Object.keys(sums)) {
    if (counts[key] > 0) result[key] = Math.round((sums[key] / counts[key]) * 10) / 10;
  }
  return result;
}

async function upsertAggregated(locationId, bucketType, bucketAt, data) {
  if (Object.keys(data).length === 0) return;
  await db.query(
    `INSERT INTO environment_readings_aggregated (location_id, bucket_type, bucket_at, data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (location_id, bucket_type, bucket_at)
     DO UPDATE SET data = EXCLUDED.data, created_at = CURRENT_TIMESTAMP`,
    [locationId, bucketType, bucketAt, JSON.stringify(data)]
  );
}

/** 依區間計算並寫入彙總（共用邏輯） */
async function computeAndSaveBucket(bucketType, bucketAt, periodEnd) {
  const locationIds = await getEnvironmentLocationIds();
  for (const locationId of locationIds) {
    const rows = await db.query(
      `SELECT data FROM environment_readings
       WHERE location_id = $1 AND recorded_at >= $2 AND recorded_at < $3`,
      [locationId, bucketAt, periodEnd]
    );
    await upsertAggregated(locationId, bucketType, bucketAt, computeAverageData(rows || []));
  }
}

async function computeAndSaveHour() {
  const now = new Date();
  const bucketAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() - 1, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0));
  await computeAndSaveBucket("hour", bucketAt, periodEnd);
}

async function computeAndSaveDay() {
  const now = new Date();
  const bucketAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  await computeAndSaveBucket("day", bucketAt, periodEnd);
}

async function computeAndSaveMonth() {
  const now = new Date();
  const bucketAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  await computeAndSaveBucket("month", bucketAt, periodEnd);
}

/** 備份排程用：一次取得 locationIds，寫入昨日 day ＋ 上月 month（少一次查詢） */
async function computeAndSaveDayAndMonth() {
  const locationIds = await getEnvironmentLocationIds();
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0));
  const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  for (const locationId of locationIds) {
    const [dayRows, monthRows] = await Promise.all([
      db.query(`SELECT data FROM environment_readings WHERE location_id = $1 AND recorded_at >= $2 AND recorded_at < $3`, [locationId, dayStart, dayEnd]),
      db.query(`SELECT data FROM environment_readings WHERE location_id = $1 AND recorded_at >= $2 AND recorded_at < $3`, [locationId, monthStart, monthEnd]),
    ]);
    await Promise.all([
      upsertAggregated(locationId, "day", dayStart, computeAverageData(dayRows || [])),
      upsertAggregated(locationId, "month", monthStart, computeAverageData(monthRows || [])),
    ]);
  }
}

module.exports = {
  getEnvironmentLocationIds,
  computeAndSaveHour,
  computeAndSaveDay,
  computeAndSaveMonth,
  computeAndSaveDayAndMonth,
};
