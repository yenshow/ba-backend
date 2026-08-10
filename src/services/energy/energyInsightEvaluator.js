/**
 * 能源 Insight 偵測器（不落 alerts，僅儀表板通知）
 */
const energySettingsService = require("./energySettingsService");
const energyAggregationService = require("./energyAggregationService");
const energyReadingsService = require("./energyReadingsService");

function startOfLocalDayUtc(offsetDays = 0) {
  const now = new Date();
  const local = new Date(now.getTime() + 8 * 3600 * 1000);
  const startLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - offsetDays,
    0,
    0,
    0,
    0,
  );
  return new Date(startLocal - 8 * 3600 * 1000);
}

function sumField(rows, field) {
  return (rows || []).reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
}

function percentOf(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function localDayKey(date) {
  const local = new Date(new Date(date).getTime() + 8 * 3600 * 1000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function loadAgg(deviceIds, bucketType, startTime, endTime) {
  let rows = await energyAggregationService.queryAggregated({
    deviceIds,
    bucketType,
    startTime,
    endTime,
  });
  if (rows.length === 0 && bucketType === "hour") {
    const all = [];
    for (const id of deviceIds) {
      all.push(
        ...(await energyAggregationService.computeHourDeltasFromRaw(
          id,
          startTime,
          endTime,
        )),
      );
    }
    rows = all;
  }
  return rows;
}

function groupDailyTotals(rows) {
  const byDay = new Map();
  for (const row of rows || []) {
    const key = localDayKey(row.bucket_at);
    const cur = byDay.get(key) || { energy: 0, water: 0, offPeak: 0 };
    cur.energy += Number(row.delta_energy_kwh) || 0;
    cur.water += Number(row.delta_water_m3) || 0;
    cur.offPeak += Number(row.tou_off_peak_kwh) || 0;
    byDay.set(key, cur);
  }
  return byDay;
}

function avgPositive(values) {
  const positive = values.filter((v) => v > 0);
  if (positive.length === 0) return 0;
  return positive.reduce((a, b) => a + b, 0) / positive.length;
}

/**
 * @returns {Promise<Array<{ id: string, kind: 'insight', message: string, created_at: string }>>}
 */
async function evaluateEnergyInsights() {
  const { config } = await energySettingsService.getSettings();
  const ids = config.include_device_ids || [];
  if (ids.length === 0) return [];

  const now = new Date();
  const todayStart = startOfLocalDayUtc(0);
  const insights = [];
  const stamp = now.toISOString();

  const todayRows = await loadAgg(ids, "hour", todayStart, now);
  const todayEnergy = sumField(todayRows, "delta_energy_kwh");
  const todayWater = sumField(todayRows, "delta_water_m3");
  const todayOffPeak = sumField(todayRows, "tou_off_peak_kwh");

  const historyDays = Math.max(
    config.usage_vs_avg_enabled || config.water_usage_vs_avg_enabled
      ? Number(config.usage_vs_avg_days) || 30
      : 0,
    config.offpeak_low_enabled ? Number(config.offpeak_baseline_days) || 14 : 0,
  );

  let dailyTotals = new Map();
  if (historyDays > 0) {
    const historyRows = await loadAgg(
      ids,
      "day",
      startOfLocalDayUtc(historyDays),
      todayStart,
    );
    dailyTotals = groupDailyTotals(historyRows);
  }

  const pastDailyValues = (field) =>
    [...dailyTotals.values()].map((v) => v[field]);

  if (config.usage_vs_avg_enabled && todayEnergy > 0) {
    const days = Number(config.usage_vs_avg_days) || 30;
    const pct = Number(config.usage_vs_avg_pct) || 90;
    const avgDaily = avgPositive(pastDailyValues("energy"));
    if (avgDaily > 0) {
      const ratio = (todayEnergy / avgDaily) * 100;
      if (ratio >= pct) {
        insights.push({
          id: "usage_vs_avg_energy",
          kind: "insight",
          message: `本日累計用電已達近 ${days} 日平均值 ${Math.round(ratio)}%`,
          created_at: stamp,
        });
      }
    }
  }

  if (config.water_usage_vs_avg_enabled && todayWater > 0) {
    const days = Number(config.usage_vs_avg_days) || 30;
    const pct = Number(config.usage_vs_avg_pct) || 90;
    const avgDaily = avgPositive(pastDailyValues("water"));
    if (avgDaily > 0) {
      const ratio = (todayWater / avgDaily) * 100;
      if (ratio >= pct) {
        insights.push({
          id: "usage_vs_avg_water",
          kind: "insight",
          message: `本日累計用水已達近 ${days} 日平均值 ${Math.round(ratio)}%`,
          created_at: stamp,
        });
      }
    }
  }

  if (config.offpeak_low_enabled) {
    const days = Number(config.offpeak_baseline_days) || 14;
    const pct = Number(config.offpeak_low_pct) || 70;
    const avgOff = avgPositive(pastDailyValues("offPeak"));
    if (avgOff > 0 && todayOffPeak < avgOff * (pct / 100)) {
      insights.push({
        id: "offpeak_low",
        kind: "insight",
        message: `今日離峰用電 ${todayOffPeak.toFixed(1)} kWh 低於近 ${days} 日離峰均值 ${Math.round(pct)}% 以下`,
        created_at: stamp,
      });
    }
  }

  if (config.meter_share_enabled && todayEnergy > 0) {
    const sharePct = Number(config.meter_share_pct) || 40;
    const byDevice = new Map();
    for (const r of todayRows) {
      const id = r.device_id;
      byDevice.set(id, (byDevice.get(id) || 0) + (Number(r.delta_energy_kwh) || 0));
    }
    const latest = await energyReadingsService.getLatestReadings(ids);
    const nameById = new Map(
      (latest || []).map((r) => [r.device_id, r.device_name || `設備 #${r.device_id}`]),
    );
    for (const [deviceId, energy] of byDevice.entries()) {
      if (!(energy > 0)) continue;
      const pct = percentOf(energy, todayEnergy);
      if (pct >= sharePct) {
        const name = nameById.get(deviceId) || `設備 #${deviceId}`;
        insights.push({
          id: `meter_share_${deviceId}`,
          kind: "insight",
          message: `${name} 今日用電佔總量 ${pct}%（超過 ${sharePct}% 門檻）`,
          created_at: stamp,
        });
      }
    }
  }

  return insights;
}

module.exports = {
  evaluateEnergyInsights,
};
