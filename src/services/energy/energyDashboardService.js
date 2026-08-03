/**
 * 能源 Dashboard／趨勢／分佈／排行／參考費
 */
const db = require("../../database/db");
const energySettingsService = require("./energySettingsService");
const energyReadingsService = require("./energyReadingsService");
const energyAggregationService = require("./energyAggregationService");

function startOfLocalDayUtc() {
  const now = new Date();
  const local = new Date(now.getTime() + 8 * 3600 * 1000);
  const startLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  return new Date(startLocal - 8 * 3600 * 1000);
}

function startOfLocalMonthUtc() {
  const now = new Date();
  const local = new Date(now.getTime() + 8 * 3600 * 1000);
  const startLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    1,
    0,
    0,
    0,
    0,
  );
  return new Date(startLocal - 8 * 3600 * 1000);
}

function sumField(rows, field) {
  return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
}

function calcElectricityCost(rows, tariff) {
  const peak = sumField(rows, "tou_peak_kwh");
  const semi = sumField(rows, "tou_semi_peak_kwh");
  const off = sumField(rows, "tou_off_peak_kwh");
  const cost =
    peak * (Number(tariff?.peak?.rate) || 0) +
    semi * (Number(tariff?.semi_peak?.rate) || 0) +
    off * (Number(tariff?.off_peak?.rate) || 0);
  return {
    isReference: true,
    currency: tariff?.currency || "TWD",
    peak_kwh: peak,
    semi_peak_kwh: semi,
    off_peak_kwh: off,
    amount: Math.round(cost * 100) / 100,
  };
}

async function loadAgg(deviceIds, bucketType, start, end) {
  let rows = await energyAggregationService.queryAggregated({
    deviceIds,
    bucketType,
    startTime: start,
    endTime: end,
  });
  if (rows.length === 0 && bucketType === "hour") {
    const all = [];
    for (const id of deviceIds) {
      const computed = await energyAggregationService.computeHourDeltasFromRaw(
        id,
        start,
        end,
      );
      all.push(...computed);
    }
    return { rows: all, source: "raw_computed" };
  }
  return { rows, source: "aggregated" };
}

async function getDashboardSummary() {
  const { config } = await energySettingsService.getSettings();
  const ids = config.include_device_ids || [];
  const now = new Date();
  const dayStart = startOfLocalDayUtc();
  const monthStart = startOfLocalMonthUtc();

  const dayAgg = await loadAgg(ids, "hour", dayStart, now);
  const monthAgg = await loadAgg(ids, "day", monthStart, now);

  const todayEnergy = sumField(dayAgg.rows, "delta_energy_kwh");
  const todayWater = sumField(dayAgg.rows, "delta_water_m3");
  // 本月：既有 day 桶（不含今日）+ 今日 hour 桶，避免 day job 尚未寫入導致少算今日
  let monthEnergyRows;
  if (monthAgg.rows.length > 0) {
    const priorDays = monthAgg.rows.filter(
      (r) => new Date(r.bucket_at).getTime() < dayStart.getTime(),
    );
    monthEnergyRows = [...priorDays, ...dayAgg.rows];
  } else {
    monthEnergyRows = (await loadAgg(ids, "hour", monthStart, now)).rows;
  }

  const latest = await energyReadingsService.getLatestReadings(ids);
  let totalPower = 0;
  let totalDemand = 0;
  let hasDemand = false;
  for (const r of latest) {
    const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    if (typeof data?.active_power === "number") totalPower += data.active_power;
    if (typeof data?.demand === "number") {
      totalDemand += data.demand;
      hasDemand = true;
    }
  }
  const demandKw = hasDemand ? totalDemand : totalPower;
  const contract = Number(config.contract_capacity_kw) || 0;
  const overContract = contract > 0 && demandKw >= contract;

  const elecCost = calcElectricityCost(
    monthEnergyRows,
    config.electricity_tariff,
  );
  const monthWater = sumField(monthEnergyRows, "delta_water_m3");
  const waterCost = {
    isReference: true,
    currency: "TWD",
    amount:
      Math.round(monthWater * (Number(config.water_tariff?.rate) || 0) * 100) /
      100,
  };

  return {
    todayEnergyKwh: Math.round(todayEnergy * 1000) / 1000,
    todayWaterM3: Math.round(todayWater * 1000) / 1000,
    contractCapacityKw: contract,
    currentDemandKw: Math.round(demandKw * 1000) / 1000,
    currentPowerKw: Math.round(totalPower * 1000) / 1000,
    overContract,
    demandAlertEnabled: config.demand_alert_enabled,
    monthElectricityCost: elecCost,
    monthWaterCost: waterCost,
    includedDeviceCount: ids.length,
    meta: { daySource: dayAgg.source, monthSource: monthAgg.source },
  };
}

async function getTrends(range = "day") {
  const allowed = new Set(["day", "week", "month", "year"]);
  const normalized = allowed.has(String(range)) ? String(range) : "day";
  const { config } = await energySettingsService.getSettings();
  const ids = config.include_device_ids || [];
  const now = new Date();
  let bucketType = "hour";
  let start = startOfLocalDayUtc();

  if (normalized === "day") {
    bucketType = "hour";
    start = startOfLocalDayUtc();
  } else if (normalized === "week") {
    bucketType = "day";
    start = new Date(startOfLocalDayUtc().getTime() - 6 * 24 * 3600 * 1000);
  } else if (normalized === "month") {
    bucketType = "day";
    start = startOfLocalMonthUtc();
  } else if (normalized === "year") {
    bucketType = "month";
    const local = new Date(now.getTime() + 8 * 3600 * 1000);
    start = new Date(
      Date.UTC(local.getUTCFullYear(), 0, 1, 0, 0, 0, 0) - 8 * 3600 * 1000,
    );
  }

  const { rows, source } = await loadAgg(ids, bucketType, start, now);
  const byBucket = new Map();
  for (const r of rows) {
    const key = new Date(r.bucket_at).toISOString();
    const cur = byBucket.get(key) || {
      timestamp: key,
      energyKwh: 0,
      waterM3: 0,
    };
    cur.energyKwh += Number(r.delta_energy_kwh) || 0;
    cur.waterM3 += Number(r.delta_water_m3) || 0;
    byBucket.set(key, cur);
  }
  const series = Array.from(byBucket.values()).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  return { range: normalized, bucketType, series, meta: { source } };
}

async function getDistribution() {
  const { config } = await energySettingsService.getSettings();
  const ids = config.include_device_ids || [];
  const dayStart = startOfLocalDayUtc();
  const { rows } = await loadAgg(ids, "hour", dayStart, new Date());

  const byDevice = new Map();
  for (const r of rows) {
    const id = Number(r.device_id);
    byDevice.set(id, (byDevice.get(id) || 0) + (Number(r.delta_energy_kwh) || 0));
  }

  const names = await db.query(
    `SELECT id, name FROM devices WHERE id = ANY($1::int[])`,
    [ids],
  );
  const nameMap = new Map((names || []).map((n) => [n.id, n.name]));
  const total = Array.from(byDevice.values()).reduce((a, b) => a + b, 0);
  const items = Array.from(byDevice.entries())
    .map(([deviceId, value]) => ({
      deviceId,
      deviceName: nameMap.get(deviceId) || `設備 #${deviceId}`,
      energyKwh: Math.round(value * 1000) / 1000,
      percent: total > 0 ? Math.round((value / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.energyKwh - a.energyKwh);

  return { totalEnergyKwh: Math.round(total * 1000) / 1000, items };
}

async function getRanking(limit = 5) {
  const dist = await getDistribution();
  return { items: dist.items.slice(0, Math.max(1, Math.min(limit, 50))) };
}

module.exports = {
  getDashboardSummary,
  getTrends,
  getDistribution,
  getRanking,
};
