/**
 * 能源用量彙總：累積差分 + TOU（Asia/Taipei）
 */
const db = require("../../database/db");
const energySettingsService = require("./energySettingsService");
const logger = require("../../utils/logger").createLogger(
  "energyAggregationService",
);

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function parseHhMm(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function windowMatches(windows, localDate) {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  const minutes = localDate.getUTCHours() * 60 + localDate.getUTCMinutes();
  const dow = localDate.getUTCDay();
  for (const w of windows) {
    const start = parseHhMm(w.start);
    const end = parseHhMm(w.end);
    if (start == null || end == null) continue;
    const dowOk =
      w.dow === "all" ||
      w.dow == null ||
      Number(w.dow) === dow ||
      (Array.isArray(w.dow) && w.dow.map(Number).includes(dow));
    if (!dowOk) continue;
    if (start <= end) {
      if (minutes >= start && minutes < end) return true;
    } else if (minutes >= start || minutes < end) {
      return true;
    }
  }
  return false;
}

function classifyTouBand(utcBucketAt, tariff) {
  const local = new Date(new Date(utcBucketAt).getTime() + TAIPEI_OFFSET_MS);
  if (windowMatches(tariff?.peak?.windows, local)) return "peak";
  if (windowMatches(tariff?.semi_peak?.windows, local)) return "semi_peak";
  return "off_peak";
}

async function getIncludeDeviceIds() {
  const { config } = await energySettingsService.getSettings();
  return config.include_device_ids || [];
}

async function computeDeltaForDevice(deviceId, periodStart, periodEnd) {
  const rows = await db.query(
    `
    SELECT recorded_at, data
    FROM energy_readings
    WHERE device_id = $1
      AND recorded_at >= $2
      AND recorded_at < $3
    ORDER BY recorded_at ASC
    `,
    [deviceId, periodStart, periodEnd],
  );
  if (!rows?.length) {
    return {
      delta_energy_kwh: null,
      delta_water_m3: null,
      max_power_kw: null,
      max_demand_kw: null,
    };
  }

  const first = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
  const last =
    typeof rows[rows.length - 1].data === "string"
      ? JSON.parse(rows[rows.length - 1].data)
      : rows[rows.length - 1].data;

  const diff = (a, b) => {
    if (typeof a !== "number" || typeof b !== "number") return null;
    const d = b - a;
    if (d < 0) {
      logger.warn("累積量負差（視為換表／溢位）", { deviceId, a, b });
      return 0;
    }
    return d;
  };

  let maxPower = null;
  let maxDemand = null;
  for (const r of rows) {
    const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    if (typeof data?.active_power === "number") {
      maxPower = maxPower == null ? data.active_power : Math.max(maxPower, data.active_power);
    }
    if (typeof data?.demand === "number") {
      maxDemand = maxDemand == null ? data.demand : Math.max(maxDemand, data.demand);
    }
  }

  return {
    delta_energy_kwh: diff(first?.active_energy, last?.active_energy),
    delta_water_m3: diff(first?.water_volume, last?.water_volume),
    max_power_kw: maxPower,
    max_demand_kw: maxDemand,
  };
}

async function upsertBucket({ deviceId, bucketType, bucketAt, periodEnd, tariff }) {
  const deltas = await computeDeltaForDevice(deviceId, bucketAt, periodEnd);
  let tou_peak_kwh = null;
  let tou_semi_peak_kwh = null;
  let tou_off_peak_kwh = null;

  if (bucketType === "hour" && deltas.delta_energy_kwh != null) {
    const band = classifyTouBand(bucketAt, tariff);
    tou_peak_kwh = band === "peak" ? deltas.delta_energy_kwh : 0;
    tou_semi_peak_kwh = band === "semi_peak" ? deltas.delta_energy_kwh : 0;
    tou_off_peak_kwh = band === "off_peak" ? deltas.delta_energy_kwh : 0;
  }

  if (bucketType === "day" || bucketType === "month") {
    const childType = bucketType === "day" ? "hour" : "day";
    const childRows = await db.query(
      `
      SELECT
        COUNT(*)::int AS n,
        COALESCE(SUM(tou_peak_kwh), 0) AS peak,
        COALESCE(SUM(tou_semi_peak_kwh), 0) AS semi,
        COALESCE(SUM(tou_off_peak_kwh), 0) AS off,
        COALESCE(SUM(delta_energy_kwh), 0) AS energy,
        COALESCE(SUM(delta_water_m3), 0) AS water,
        MAX(max_power_kw) AS max_power,
        MAX(max_demand_kw) AS max_demand
      FROM energy_usage_aggregated
      WHERE device_id = $1
        AND bucket_type = $2
        AND bucket_at >= $3
        AND bucket_at < $4
      `,
      [deviceId, childType, bucketAt, periodEnd],
    );
    const c = childRows?.[0];
    if (c && Number(c.n) > 0) {
      deltas.delta_energy_kwh = Number(c.energy) || 0;
      deltas.delta_water_m3 = Number(c.water) || 0;
      deltas.max_power_kw = c.max_power != null ? Number(c.max_power) : deltas.max_power_kw;
      deltas.max_demand_kw = c.max_demand != null ? Number(c.max_demand) : deltas.max_demand_kw;
      tou_peak_kwh = Number(c.peak) || 0;
      tou_semi_peak_kwh = Number(c.semi) || 0;
      tou_off_peak_kwh = Number(c.off) || 0;
    }
  }

  await db.query(
    `
    INSERT INTO energy_usage_aggregated (
      device_id, bucket_type, bucket_at,
      delta_energy_kwh, delta_water_m3,
      tou_peak_kwh, tou_semi_peak_kwh, tou_off_peak_kwh,
      max_power_kw, max_demand_kw, data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (device_id, bucket_type, bucket_at)
    DO UPDATE SET
      delta_energy_kwh = EXCLUDED.delta_energy_kwh,
      delta_water_m3 = EXCLUDED.delta_water_m3,
      tou_peak_kwh = EXCLUDED.tou_peak_kwh,
      tou_semi_peak_kwh = EXCLUDED.tou_semi_peak_kwh,
      tou_off_peak_kwh = EXCLUDED.tou_off_peak_kwh,
      max_power_kw = EXCLUDED.max_power_kw,
      max_demand_kw = EXCLUDED.max_demand_kw,
      data = EXCLUDED.data,
      created_at = CURRENT_TIMESTAMP
    `,
    [
      deviceId,
      bucketType,
      bucketAt,
      deltas.delta_energy_kwh,
      deltas.delta_water_m3,
      tou_peak_kwh,
      tou_semi_peak_kwh,
      tou_off_peak_kwh,
      deltas.max_power_kw,
      deltas.max_demand_kw,
      JSON.stringify({}),
    ],
  );
}

async function computeAndSaveBucket(bucketType, bucketAt, periodEnd) {
  const ids = await getIncludeDeviceIds();
  const { config } = await energySettingsService.getSettings();
  for (const deviceId of ids) {
    try {
      await upsertBucket({
        deviceId,
        bucketType,
        bucketAt,
        periodEnd,
        tariff: config.electricity_tariff,
      });
    } catch (err) {
      logger.warn("彙總失敗", { deviceId, bucketType, error: err.message });
    }
  }
}

async function computeAndSaveHour() {
  const now = new Date();
  const bucketAt = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() - 1,
      0,
      0,
      0,
    ),
  );
  const periodEnd = new Date(bucketAt.getTime() + 60 * 60 * 1000);
  await computeAndSaveBucket("hour", bucketAt, periodEnd);
}

async function upsertPartialCurrentHour() {
  const now = new Date();
  const bucketAt = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0,
      0,
      0,
    ),
  );
  await computeAndSaveBucket("hour", bucketAt, now);
}

async function computeAndSaveDay() {
  const now = new Date();
  const bucketAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0),
  );
  const periodEnd = new Date(bucketAt.getTime() + 24 * 60 * 60 * 1000);
  await computeAndSaveBucket("day", bucketAt, periodEnd);

  const monthAt = new Date(Date.UTC(bucketAt.getUTCFullYear(), bucketAt.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(bucketAt.getUTCFullYear(), bucketAt.getUTCMonth() + 1, 1));
  await computeAndSaveBucket("month", monthAt, monthEnd);
}

async function backfillTodayHours() {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  for (let h = 0; h <= now.getUTCHours(); h++) {
    const bucketAt = new Date(start.getTime() + h * 3600 * 1000);
    const periodEnd = new Date(bucketAt.getTime() + 3600 * 1000);
    const end = periodEnd > now ? now : periodEnd;
    await computeAndSaveBucket("hour", bucketAt, end);
  }
}

async function backfillRecentDays(days = 7) {
  const now = new Date();
  for (let i = 1; i <= days; i++) {
    const bucketAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i, 0, 0, 0, 0),
    );
    const periodEnd = new Date(bucketAt.getTime() + 24 * 60 * 60 * 1000);
    await computeAndSaveBucket("day", bucketAt, periodEnd);
  }
}

async function queryAggregated({ deviceIds, bucketType, startTime, endTime }) {
  const ids = (deviceIds || []).map((x) => Number(x)).filter(Number.isFinite);
  if (ids.length === 0) return [];
  const rows = await db.query(
    `
    SELECT *
    FROM energy_usage_aggregated
    WHERE device_id = ANY($1::int[])
      AND bucket_type = $2
      AND bucket_at >= $3
      AND bucket_at < $4
    ORDER BY bucket_at ASC, device_id ASC
    `,
    [ids, bucketType, new Date(startTime), new Date(endTime)],
  );
  return rows || [];
}

/**
 * 由 raw 計算 hour delta（API fallback）
 */
async function computeHourDeltasFromRaw(deviceId, startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const out = [];
  let cursor = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
      start.getUTCHours(),
      0,
      0,
      0,
    ),
  );
  const { config } = await energySettingsService.getSettings();
  while (cursor < end) {
    const periodEnd = new Date(cursor.getTime() + 3600 * 1000);
    const deltas = await computeDeltaForDevice(deviceId, cursor, periodEnd > end ? end : periodEnd);
    if (deltas.delta_energy_kwh != null || deltas.delta_water_m3 != null) {
      const band = classifyTouBand(cursor, config.electricity_tariff);
      out.push({
        device_id: deviceId,
        bucket_type: "hour",
        bucket_at: cursor,
        ...deltas,
        tou_peak_kwh: band === "peak" ? deltas.delta_energy_kwh : 0,
        tou_semi_peak_kwh: band === "semi_peak" ? deltas.delta_energy_kwh : 0,
        tou_off_peak_kwh: band === "off_peak" ? deltas.delta_energy_kwh : 0,
      });
    }
    cursor = periodEnd;
  }
  return out;
}

module.exports = {
  computeAndSaveHour,
  upsertPartialCurrentHour,
  computeAndSaveDay,
  backfillTodayHours,
  backfillRecentDays,
  queryAggregated,
  computeHourDeltasFromRaw,
};
