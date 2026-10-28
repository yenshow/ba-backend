/**
 * 參考電費：TOU（分季費率）＋超額加價＋功率因數獎懲
 */
const {
  BANDS,
  getBandRate,
  isSummerUtc,
} = require("../../constants/taipowerTouDefaults");
const { calcPowerFactorBillAdjustment } = require("./powerFactorBillAdjustment");

const BAND_LABEL = {
  peak: "尖峰",
  semi_peak: "半尖峰",
  off_peak: "離峰",
};

const FIELD_BY_BAND = {
  peak: "tou_peak_kwh",
  semi_peak: "tou_semi_peak_kwh",
  off_peak: "tou_off_peak_kwh",
};

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function rowBandKwh(row, band) {
  const field = FIELD_BY_BAND[band];
  const raw = row?.[field];
  if (raw != null && Number.isFinite(Number(raw))) return Number(raw) || 0;
  if (band === "off_peak") {
    const hasTou =
      row?.tou_peak_kwh != null ||
      row?.tou_semi_peak_kwh != null ||
      row?.tou_off_peak_kwh != null;
    if (!hasTou) return Number(row?.delta_energy_kwh) || 0;
  }
  return 0;
}

function rowTimestamp(row) {
  return row?.bucket_at || row?.timestamp || null;
}

function combineStationPf(devicePfList, kwhByDevice) {
  let weighted = 0;
  let weight = 0;
  let arith = 0;
  let n = 0;
  for (const item of devicePfList || []) {
    const pct = item.pfPercent;
    if (pct == null || !Number.isFinite(pct)) continue;
    n += 1;
    const kwh = Number(kwhByDevice.get(Number(item.deviceId))) || 0;
    if (kwh > 0) {
      weighted += pct * kwh;
      weight += kwh;
    }
    arith += pct;
  }
  if (n === 0) return { pfPercent: null, sampleDeviceCount: 0 };
  if (weight > 0) {
    return { pfPercent: weighted / weight, sampleDeviceCount: n };
  }
  return { pfPercent: arith / n, sampleDeviceCount: n };
}

function calcReferenceElectricityCost(rows, tariff, pfConfig, pfPercent, sampleDeviceCount) {
  const list = Array.isArray(rows) ? rows : [];
  const totals = { peak: 0, semi_peak: 0, off_peak: 0 };
  const lineMap = new Map();

  for (const row of list) {
    const summer = isSummerUtc(rowTimestamp(row), tariff);
    const season = summer ? "summer" : "non_summer";
    for (const band of BANDS) {
      const kwh = rowBandKwh(row, band);
      if (!kwh) continue;
      totals[band] += kwh;
      const key = `${band}:${season}`;
      const cur = lineMap.get(key) || {
        band,
        season,
        kwh: 0,
        rate: getBandRate(tariff, band, summer),
      };
      cur.kwh += kwh;
      lineMap.set(key, cur);
    }
  }

  const touLineItems = Array.from(lineMap.values()).map((item) => {
    const subtotal = round2(item.kwh * item.rate);
    return {
      band: item.band,
      season: item.season,
      label: `${BAND_LABEL[item.band]}（${item.season === "summer" ? "夏月" : "非夏月"}）`,
      kwh: round3(item.kwh),
      rate: item.rate,
      subtotal,
    };
  });

  const baseAmount = round2(
    touLineItems.reduce((acc, item) => acc + item.subtotal, 0),
  );
  const totalKwh = totals.peak + totals.semi_peak + totals.off_peak;
  const threshold = Number(tariff?.excess_threshold_kwh);
  const surcharge = Number(tariff?.excess_surcharge_per_kwh);
  const excessKwh =
    Number.isFinite(threshold) && threshold > 0
      ? Math.max(0, totalKwh - threshold)
      : 0;
  const excessAmount = round2(
    excessKwh * (Number.isFinite(surcharge) ? surcharge : 0),
  );
  const prePf = round2(baseAmount + excessAmount);
  const pf = calcPowerFactorBillAdjustment(prePf, pfPercent, pfConfig);

  return {
    isReference: true,
    currency: tariff?.currency || "TWD",
    amount: pf.finalAmount,
    baseAmount,
    excessKwh: round3(excessKwh),
    excessAmount,
    peak_kwh: round3(totals.peak),
    semi_peak_kwh: round3(totals.semi_peak),
    off_peak_kwh: round3(totals.off_peak),
    touLineItems,
    powerFactor: {
      enabled: pf.enabled,
      avgPercent:
        pf.measuredPct == null ? null : Math.round(pf.measuredPct * 1000) / 1000,
      baselinePercent: pf.baselinePct,
      rewardCapPercent: pf.rewardCapPct,
      billDeltaPercent: pf.billDeltaPct,
      adjustmentAmount: pf.adjustmentAmount,
      sampleDeviceCount: Number(sampleDeviceCount) || 0,
      applied: pf.applied,
    },
  };
}

module.exports = {
  calcReferenceElectricityCost,
  combineStationPf,
};
