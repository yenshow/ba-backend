/**
 * 能源 Dashboard／趨勢／分佈／排行／參考費
 */
const db = require("../../database/db");
const energySettingsService = require("./energySettingsService");
const energyReadingsService = require("./energyReadingsService");
const energyAggregationService = require("./energyAggregationService");
const {
  normalizeEnergyUsageSystemKey,
  getEnergyUsageSystemLabel,
  DEFAULT_USAGE_SYSTEM_KEY,
} = require("../../constants/energyUsageSystemCatalog");

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

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function percentOf(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function parseDeviceConfig(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
}

/**
 * 載入納入設備的今日電量（by device）與裝置中繼資料
 */
async function loadTodayDeviceEnergy(ids) {
  const dayStart = startOfLocalDayUtc();
  const { rows } = await loadAgg(ids, "hour", dayStart, new Date());

  const byDevice = new Map();
  for (const r of rows) {
    const id = Number(r.device_id);
    byDevice.set(
      id,
      (byDevice.get(id) || 0) + (Number(r.delta_energy_kwh) || 0),
    );
  }

  const devices =
    ids.length === 0
      ? []
      : await db.query(
          `SELECT id, name, location, config FROM devices WHERE id = ANY($1::int[])`,
          [ids],
        );

  const deviceMeta = new Map();
  for (const d of devices || []) {
    const cfg = parseDeviceConfig(d.config);
    const systemKey = normalizeEnergyUsageSystemKey(cfg.energy_usage_system);
    deviceMeta.set(d.id, {
      deviceId: d.id,
      deviceName: d.name || `設備 #${d.id}`,
      location: d.location || null,
      systemKey,
      systemName: getEnergyUsageSystemLabel(systemKey),
      energyKwh: round3(byDevice.get(d.id) || 0),
    });
  }

  // 有彙總但設備已被刪／不在查詢結果：仍保留用量
  for (const [id, energy] of byDevice.entries()) {
    if (deviceMeta.has(id)) continue;
    const systemKey = DEFAULT_USAGE_SYSTEM_KEY;
    deviceMeta.set(id, {
      deviceId: id,
      deviceName: `設備 #${id}`,
      location: null,
      systemKey,
      systemName: getEnergyUsageSystemLabel(systemKey),
      energyKwh: round3(energy),
    });
  }

  const total = Array.from(deviceMeta.values()).reduce(
    (a, d) => a + d.energyKwh,
    0,
  );
  return { deviceMeta, totalEnergyKwh: round3(total) };
}

/**
 * 電量使用分佈：共最多 6 項＝5 個具名系統 +「其他系統」
 *（other 與超出 Top5 的具名系統併入「其他系統」）
 */
async function getDistribution() {
  const { config } = await energySettingsService.getSettings();
  const ids = config.include_device_ids || [];
  const { deviceMeta, totalEnergyKwh } = await loadTodayDeviceEnergy(ids);

  const bySystem = new Map();
  for (const d of deviceMeta.values()) {
    const cur = bySystem.get(d.systemKey) || {
      systemKey: d.systemKey,
      systemName: d.systemName,
      energyKwh: 0,
      deviceCount: 0,
    };
    cur.energyKwh += d.energyKwh;
    cur.deviceCount += 1;
    bySystem.set(d.systemKey, cur);
  }

  const sorted = Array.from(bySystem.values())
    .map((s) => ({ ...s, energyKwh: round3(s.energyKwh) }))
    .sort((a, b) => b.energyKwh - a.energyKwh);

  const named = sorted.filter((s) => s.systemKey !== DEFAULT_USAGE_SYSTEM_KEY);
  const otherExisting = sorted.find(
    (s) => s.systemKey === DEFAULT_USAGE_SYSTEM_KEY,
  );

  /** 具名系統最多 5；再加上「其他系統」共最多 6 */
  const TOP_NAMED = 5;
  const top = named.slice(0, TOP_NAMED);
  const rest = named.slice(TOP_NAMED);
  const otherEnergy =
    (otherExisting?.energyKwh || 0) +
    rest.reduce((a, s) => a + s.energyKwh, 0);
  const otherCount =
    (otherExisting?.deviceCount || 0) +
    rest.reduce((a, s) => a + s.deviceCount, 0);

  const items = top.map((s) => ({
    systemKey: s.systemKey,
    systemName: s.systemName,
    energyKwh: round3(s.energyKwh),
    percent: percentOf(s.energyKwh, totalEnergyKwh),
    deviceCount: s.deviceCount,
  }));

  if (otherEnergy > 0 || otherCount > 0) {
    items.push({
      systemKey: DEFAULT_USAGE_SYSTEM_KEY,
      systemName: "其他系統",
      energyKwh: round3(otherEnergy),
      percent: percentOf(otherEnergy, totalEnergyKwh),
      deviceCount: otherCount,
    });
  }

  return { totalEnergyKwh, items };
}

/**
 * 用電排行：電表設備維度 Top N
 */
async function getRanking(limit = 5) {
  const { config } = await energySettingsService.getSettings();
  const ids = config.include_device_ids || [];
  const { deviceMeta, totalEnergyKwh } = await loadTodayDeviceEnergy(ids);
  const capped = Math.max(1, Math.min(parseInt(limit, 10) || 5, 50));

  const items = Array.from(deviceMeta.values())
    .sort((a, b) => b.energyKwh - a.energyKwh)
    .slice(0, capped)
    .map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      energyKwh: d.energyKwh,
      percent: percentOf(d.energyKwh, totalEnergyKwh),
    }));

  return { items, totalEnergyKwh };
}

/**
 * 系統 → 電表明細（分佈／排行「查看更多」共用）
 */
async function getBreakdown() {
  const { config } = await energySettingsService.getSettings();
  const ids = config.include_device_ids || [];
  const includeSet = new Set(ids.map((id) => Number(id)));
  const { deviceMeta, totalEnergyKwh } = await loadTodayDeviceEnergy(ids);

  const latestRows = await energyReadingsService.getLatestReadings(ids);
  const latestMap = new Map();
  for (const r of latestRows) {
    const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    latestMap.set(Number(r.device_id), {
      activePowerKw:
        typeof data?.active_power === "number" ? round3(data.active_power) : null,
      recordedAt: r.recorded_at
        ? new Date(r.recorded_at).toISOString()
        : null,
    });
  }

  const bySystem = new Map();
  for (const d of deviceMeta.values()) {
    const latest = latestMap.get(d.deviceId);
    const meter = {
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      systemKey: d.systemKey,
      systemName: d.systemName,
      energyKwh: d.energyKwh,
      percentOfTotal: percentOf(d.energyKwh, totalEnergyKwh),
      activePowerKw: latest?.activePowerKw ?? null,
      location: d.location,
      lastReadingAt: latest?.recordedAt ?? null,
      included: includeSet.has(d.deviceId),
    };
    const cur = bySystem.get(d.systemKey) || {
      systemKey: d.systemKey,
      systemName: d.systemName,
      energyKwh: 0,
      deviceCount: 0,
      meters: [],
    };
    cur.energyKwh += d.energyKwh;
    cur.deviceCount += 1;
    cur.meters.push(meter);
    bySystem.set(d.systemKey, cur);
  }

  const systems = Array.from(bySystem.values())
    .map((s) => {
      const systemEnergy = round3(s.energyKwh);
      const meters = s.meters
        .map((m) => ({
          ...m,
          percentOfSystem: percentOf(m.energyKwh, systemEnergy),
        }))
        .sort((a, b) => b.energyKwh - a.energyKwh);
      return {
        systemKey: s.systemKey,
        systemName: s.systemName,
        energyKwh: systemEnergy,
        percent: percentOf(systemEnergy, totalEnergyKwh),
        deviceCount: s.deviceCount,
        meters,
      };
    })
    .sort((a, b) => b.energyKwh - a.energyKwh);

  return { totalEnergyKwh, systems };
}

module.exports = {
  getDashboardSummary,
  getTrends,
  getDistribution,
  getRanking,
  getBreakdown,
};
