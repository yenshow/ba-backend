/**
 * 台電簡易型時間電價（參考用，非正式帳單）
 * 夏月 6/1–9/30；週六／日全日離峰；不含基本電費／需量／國定離峰日
 */
const WEEKDAYS = [1, 2, 3, 4, 5];

const wd = (start, end) => ({ dow: WEEKDAYS, start, end });

const THREE_STAGE = {
  currency: "TWD",
  scheme: "three_stage",
  summer_start: "06-01",
  summer_end: "09-30",
  excess_threshold_kwh: 2000,
  excess_surcharge_per_kwh: 1.04,
  peak: {
    summer_rate: 7.13,
    non_summer_rate: 0,
    summer_windows: [wd("16:00", "22:00")],
    non_summer_windows: [],
  },
  semi_peak: {
    summer_rate: 4.69,
    non_summer_rate: 4.48,
    summer_windows: [wd("09:00", "16:00"), wd("22:00", "24:00")],
    non_summer_windows: [wd("06:00", "11:00"), wd("14:00", "24:00")],
  },
  off_peak: {
    summer_rate: 2.06,
    non_summer_rate: 1.99,
    summer_windows: [],
    non_summer_windows: [],
  },
};

const TWO_STAGE = {
  currency: "TWD",
  scheme: "two_stage",
  summer_start: "06-01",
  summer_end: "09-30",
  excess_threshold_kwh: 2000,
  excess_surcharge_per_kwh: 1.04,
  peak: {
    summer_rate: 5.16,
    non_summer_rate: 4.93,
    summer_windows: [wd("09:00", "24:00")],
    non_summer_windows: [wd("06:00", "11:00"), wd("14:00", "24:00")],
  },
  semi_peak: {
    summer_rate: 0,
    non_summer_rate: 0,
    summer_windows: [],
    non_summer_windows: [],
  },
  off_peak: {
    summer_rate: 2.06,
    non_summer_rate: 1.99,
    summer_windows: [],
    non_summer_windows: [],
  },
};

const BANDS = ["peak", "semi_peak", "off_peak"];
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function cloneTariff(src) {
  return JSON.parse(JSON.stringify(src));
}

function buildTaipowerTariff(scheme) {
  return cloneTariff(scheme === "two_stage" ? TWO_STAGE : THREE_STAGE);
}

function parseMd(value, fallbackMonth, fallbackDay) {
  const m = String(value || "").match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return { month: fallbackMonth, day: fallbackDay };
  return { month: Number(m[1]), day: Number(m[2]) };
}

function toTaipeiLocal(utcLike) {
  return new Date(new Date(utcLike).getTime() + TAIPEI_OFFSET_MS);
}

function isSummerLocal(localDate, tariff) {
  const start = parseMd(tariff?.summer_start, 6, 1);
  const end = parseMd(tariff?.summer_end, 9, 30);
  const md = (localDate.getUTCMonth() + 1) * 100 + localDate.getUTCDate();
  return md >= start.month * 100 + start.day && md <= end.month * 100 + end.day;
}

function isSummerUtc(utcLike, tariff) {
  if (utcLike == null) return false;
  return isSummerLocal(toTaipeiLocal(utcLike), tariff);
}

function parseHhMm(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function normalizeWindows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w) => w && typeof w === "object" && w.start && w.end)
    .map((w) => ({
      dow: Array.isArray(w.dow) ? w.dow.map(Number) : w.dow ?? WEEKDAYS,
      start: String(w.start),
      end: String(w.end),
    }));
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

function bandWindows(band, summer) {
  if (!band || typeof band !== "object") return [];
  const seasonal = summer ? band.summer_windows : band.non_summer_windows;
  if (Array.isArray(seasonal) && seasonal.length > 0) return seasonal;
  if (Array.isArray(band.windows) && band.windows.length > 0) return band.windows;
  return Array.isArray(seasonal) ? seasonal : [];
}

function classifyTouBand(utcBucketAt, tariff) {
  const local = toTaipeiLocal(utcBucketAt);
  const summer = isSummerLocal(local, tariff);
  if (windowMatches(bandWindows(tariff?.peak, summer), local)) return "peak";
  if (windowMatches(bandWindows(tariff?.semi_peak, summer), local)) {
    return "semi_peak";
  }
  return "off_peak";
}

function getBandRate(tariff, bandKey, summer) {
  const band = tariff?.[bandKey];
  if (!band || typeof band !== "object") return 0;
  const seasonal = summer ? band.summer_rate : band.non_summer_rate;
  if (Number.isFinite(Number(seasonal))) return Number(seasonal);
  if (Number.isFinite(Number(band.rate))) return Number(band.rate);
  return 0;
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasSeasonalRates(et) {
  return BANDS.some((key) => {
    const b = et?.[key];
    return (
      Number.isFinite(Number(b?.summer_rate)) ||
      Number.isFinite(Number(b?.non_summer_rate)) ||
      (Array.isArray(b?.summer_windows) && b.summer_windows.length > 0) ||
      (Array.isArray(b?.non_summer_windows) && b.non_summer_windows.length > 0)
    );
  });
}

function isUnsetTariff(et) {
  if (!et || typeof et !== "object") return true;
  if (hasSeasonalRates(et)) return false;
  return BANDS.every((key) => {
    const b = et[key] || {};
    const rateZero = !Number(b.rate);
    const noWindows = !Array.isArray(b.windows) || b.windows.length === 0;
    return rateZero && noWindows;
  });
}

function normalizeBand(raw, fallback) {
  const src = raw && typeof raw === "object" ? raw : {};
  const legacyWindows = Array.isArray(src.windows) ? src.windows : null;
  return {
    summer_rate: finiteOr(src.summer_rate, finiteOr(src.rate, fallback.summer_rate)),
    non_summer_rate: finiteOr(
      src.non_summer_rate,
      finiteOr(src.rate, fallback.non_summer_rate),
    ),
    summer_windows: normalizeWindows(src.summer_windows ?? legacyWindows ?? fallback.summer_windows),
    non_summer_windows: normalizeWindows(
      src.non_summer_windows ??
        (src.summer_windows == null && legacyWindows ? legacyWindows : fallback.non_summer_windows),
    ),
  };
}

function normalizeElectricityTariff(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const scheme = src.scheme === "two_stage" ? "two_stage" : "three_stage";
  if (isUnsetTariff(src)) {
    return buildTaipowerTariff(scheme);
  }
  const fallback = buildTaipowerTariff(scheme);
  return {
    currency: src.currency || "TWD",
    scheme,
    summer_start: src.summer_start || fallback.summer_start,
    summer_end: src.summer_end || fallback.summer_end,
    excess_threshold_kwh: Math.max(
      0,
      finiteOr(src.excess_threshold_kwh, fallback.excess_threshold_kwh),
    ),
    excess_surcharge_per_kwh: Math.max(
      0,
      finiteOr(src.excess_surcharge_per_kwh, fallback.excess_surcharge_per_kwh),
    ),
    peak: normalizeBand(src.peak, fallback.peak),
    semi_peak: normalizeBand(src.semi_peak, fallback.semi_peak),
    off_peak: normalizeBand(src.off_peak, fallback.off_peak),
  };
}

module.exports = {
  BANDS,
  buildTaipowerTariff,
  classifyTouBand,
  getBandRate,
  isSummerUtc,
  isUnsetTariff,
  normalizeElectricityTariff,
};
