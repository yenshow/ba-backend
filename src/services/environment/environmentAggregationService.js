/**
 * 環境讀數彙總服務
 * 由 raw 計算時／日／月平均，寫入 environment_readings_aggregated
 * 設計：docs/40-systems/environment-data-design.md
 */

const db = require("../../database/db");

async function getEnvironmentLocationIds() {
  const rows = await db.query(`
    SELECT l.id FROM locations l
    INNER JOIN location_systems ls ON l.id = ls.location_id
    WHERE ls.system_type = 'environment'
      AND jsonb_array_length(COALESCE(ls.system_config->'device_ids', '[]'::jsonb)) > 0
  `);
  return (rows || []).map((r) => r.id);
}

/**
 * 單次 SQL 聚合（location_id + 每個 numeric key 平均），並一次性 upsert
 * - data: JSONB（含 derived 指標 aqi/heatIndex；依「平均值」語意落地）
 */
async function upsertAggregatedBySql({ locationIds, bucketType, bucketAt, periodEnd }) {
  const ids = Array.isArray(locationIds)
    ? locationIds.map((x) => Number(x)).filter((n) => Number.isFinite(n))
    : [];
  if (ids.length === 0) return;

  await db.query(
    `
      WITH src AS (
        SELECT
          er.location_id,
          e.key AS k,
          AVG((e.value)::numeric) AS avg_value
        FROM environment_readings er
        CROSS JOIN LATERAL jsonb_each_text(er.data) AS e(key, value)
        WHERE er.location_id = ANY($1::int[])
          AND er.recorded_at >= $2
          AND er.recorded_at < $3
          AND (e.value ~ '^-?\\d+(\\.\\d+)?$')
        GROUP BY er.location_id, e.key
      ),
      agg AS (
        SELECT
          location_id,
          jsonb_object_agg(k, to_jsonb(ROUND(avg_value::numeric, 1))) AS data
        FROM src
        GROUP BY location_id
      )
      INSERT INTO environment_readings_aggregated (location_id, bucket_type, bucket_at, data)
      SELECT a.location_id, $4, $5, a.data
      FROM agg a
      ON CONFLICT (location_id, bucket_type, bucket_at)
      DO UPDATE SET data = EXCLUDED.data, created_at = CURRENT_TIMESTAMP
    `,
    [ids, bucketAt, periodEnd, bucketType, bucketAt],
  );
}

/** 依區間計算並寫入彙總（共用邏輯） */
async function computeAndSaveBucket(bucketType, bucketAt, periodEnd) {
  const locationIds = await getEnvironmentLocationIds();
  await upsertAggregatedBySql({
    locationIds,
    bucketType,
    bucketAt,
    periodEnd,
  });
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

/**
 * 依 offsetDays 計算並寫入 day 彙總
 * offsetDays=1 表示「昨日」；offsetDays=2 表示「前天」…（UTC 日界）
 */
async function computeAndSaveDayByOffset(offsetDays) {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offsetDays, 0, 0, 0, 0));
  const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offsetDays + 1, 0, 0, 0, 0));
  await computeAndSaveBucket("day", dayStart, dayEnd);
}

/**
 * 補寫最近 N 天 day 彙總（不含今日）
 * 用途：備份排程停擺後復原資料缺口（例如只彙總到 28 號）
 */
async function backfillRecentDays(days) {
  const n = Math.max(0, Math.floor(days || 0));
  for (let offset = n; offset >= 1; offset--) {
    await computeAndSaveDayByOffset(offset);
  }
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
  await upsertAggregatedBySql({
    locationIds,
    bucketType: "day",
    bucketAt: dayStart,
    periodEnd: dayEnd,
  });
  await upsertAggregatedBySql({
    locationIds,
    bucketType: "month",
    bucketAt: monthStart,
    periodEnd: monthEnd,
  });
}

module.exports = {
  getEnvironmentLocationIds,
  computeAndSaveHour,
  computeAndSaveDay,
  computeAndSaveDayByOffset,
  backfillRecentDays,
  computeAndSaveMonth,
  computeAndSaveDayAndMonth,
};
