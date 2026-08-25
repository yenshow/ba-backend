/**
 * 轉存排程：頻率（daily／weekly／monthly）＋錨點日 00:00 資料窗
 * 對接（sync）不使用本模組，維持每日 push_time。
 *
 * 資料窗半開 [prev, curr)：curr＝最近已到（含今日）的排程日 00:00；
 * prev＝上一週期同錨點。觸發時刻 HH:mm 只影響 nextAt，不影響窗。
 */
const { DateTime } = require("luxon");

const ZONE = "Asia/Taipei";
const FREQS = new Set(["daily", "weekly", "monthly"]);

function normalizeScheduleFreq(raw) {
  const v = String(raw ?? "daily").trim().toLowerCase();
  return FREQS.has(v) ? v : "";
}

/** weekly: 1–7 (ISO)；monthly: 1–31；daily: null */
function normalizeScheduleDay(freq, raw) {
  if (freq === "daily") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const day = Math.trunc(n);
  if (freq === "weekly" && day >= 1 && day <= 7) return day;
  if (freq === "monthly" && day >= 1 && day <= 31) return day;
  return null;
}

function parseHHmm(timeHHmm) {
  const [hh, mm] = String(timeHHmm || "00:00")
    .trim()
    .split(":")
    .map((v) => Number(v));
  return {
    hour: Number.isFinite(hh) ? hh : 0,
    minute: Number.isFinite(mm) ? mm : 0,
  };
}

function clampMonthDay(dt, dayOfMonth) {
  const dim = dt.daysInMonth;
  const d = Math.min(Math.max(1, dayOfMonth), dim);
  return dt.set({ day: d, hour: 0, minute: 0, second: 0, millisecond: 0 });
}

/** curr 錨點：最近一個「排程日 00:00」且 ≤ 今日 */
function currentAnchorAt(now, freq, scheduleDay) {
  const today = now.setZone(ZONE).startOf("day");
  if (freq === "daily") return today;

  if (freq === "weekly") {
    const wd = today.weekday;
    const delta = wd >= scheduleDay ? wd - scheduleDay : wd - scheduleDay + 7;
    return today.minus({ days: delta });
  }

  const thisMonth = clampMonthDay(today.startOf("month"), scheduleDay);
  if (today >= thisMonth) return thisMonth;
  return clampMonthDay(today.minus({ months: 1 }).startOf("month"), scheduleDay);
}

function previousAnchor(curr, freq, scheduleDay) {
  if (freq === "daily") return curr.minus({ days: 1 });
  if (freq === "weekly") return curr.minus({ weeks: 1 });
  return clampMonthDay(curr.minus({ months: 1 }).startOf("month"), scheduleDay);
}

/**
 * @returns {{ start: Date, end: Date, startIso: string, endIso: string }}
 */
function resolveExportWindow({
  scheduleFreq = "daily",
  scheduleDay = null,
  now = new Date(),
}) {
  const freq = normalizeScheduleFreq(scheduleFreq) || "daily";
  const day = normalizeScheduleDay(freq, scheduleDay);
  const zonedNow = DateTime.fromJSDate(now).setZone(ZONE);
  const curr = currentAnchorAt(zonedNow, freq, day ?? 1);
  const prev = previousAnchor(curr, freq, day ?? 1);
  return {
    start: prev.toJSDate(),
    end: curr.toJSDate(),
    startIso: prev.toISO(),
    endIso: curr.toISO(),
  };
}

/** 下一次觸發：排程日 + export_time HH:mm */
function computeNextExportRunAt({
  scheduleFreq = "daily",
  scheduleDay = null,
  timeHHmm = "00:00",
  now = DateTime.now().setZone(ZONE),
}) {
  const freq = normalizeScheduleFreq(scheduleFreq) || "daily";
  const day = normalizeScheduleDay(freq, scheduleDay);
  const { hour, minute } = parseHHmm(timeHHmm);
  const zonedNow =
    now instanceof DateTime ? now.setZone(ZONE) : DateTime.fromJSDate(now).setZone(ZONE);
  const atTime = (dayDt) =>
    dayDt.set({ hour, minute, second: 0, millisecond: 0 });

  if (freq === "daily") {
    let next = atTime(zonedNow.startOf("day"));
    if (next <= zonedNow.plus({ seconds: 1 })) next = next.plus({ days: 1 });
    return next;
  }

  if (freq === "weekly") {
    const target = day ?? 5;
    const delta = (target - zonedNow.weekday + 7) % 7;
    let candidate = atTime(zonedNow.startOf("day").plus({ days: delta }));
    if (candidate <= zonedNow.plus({ seconds: 1 })) {
      candidate = candidate.plus({ weeks: 1 });
    }
    return candidate;
  }

  const targetDay = day ?? 1;
  let candidate = atTime(clampMonthDay(zonedNow.startOf("month"), targetDay));
  if (candidate <= zonedNow.plus({ seconds: 1 })) {
    candidate = atTime(
      clampMonthDay(zonedNow.plus({ months: 1 }).startOf("month"), targetDay),
    );
  }
  return candidate;
}

function computeNextDailyRunAt(timeHHmm, zone = ZONE) {
  return computeNextExportRunAt({
    scheduleFreq: "daily",
    timeHHmm,
    now: DateTime.now().setZone(zone),
  });
}

module.exports = {
  ZONE,
  normalizeScheduleFreq,
  normalizeScheduleDay,
  resolveExportWindow,
  computeNextExportRunAt,
  computeNextDailyRunAt,
};
