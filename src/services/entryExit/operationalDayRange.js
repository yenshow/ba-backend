/**
 * 營運日時間範圍（與警報日界線 ALERT_DAILY_ROLLOVER_* 共用）
 */
const { DateTime } = require("luxon");
const runtimeConfigService = require("../platform/runtimeConfigService");

function getRolloverConfig() {
  const alerts = runtimeConfigService.getAlerts();
  return {
    timezone: alerts.dailyRolloverTimezone || "Asia/Taipei",
    hour: alerts.dailyRolloverLocalHour ?? 0,
    minute: alerts.dailyRolloverLocalMinute ?? 0,
  };
}

/**
 * 目前營運日：自上次 rollover 至下次 rollover 前 1ms（UTC Date）
 * @param {Date} [now]
 * @returns {{ start: Date, end: Date }}
 */
function getOperationalDayTimeRange(now = new Date()) {
  const { timezone, hour, minute } = getRolloverConfig();
  const zoned = DateTime.fromJSDate(now, { zone: timezone });
  let start = zoned.set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  if (start > zoned) {
    start = start.minus({ days: 1 });
  }
  const end = start.plus({ days: 1 }).minus({ milliseconds: 1 });
  return {
    start: start.toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
  };
}

/**
 * 上一個完整營運日
 * @param {Date} [now]
 * @returns {{ start: Date, end: Date }}
 */
function getPreviousOperationalDayTimeRange(now = new Date()) {
  const current = getOperationalDayTimeRange(now);
  const { timezone } = getRolloverConfig();
  const startDt = DateTime.fromJSDate(current.start, { zone: "utc" }).setZone(
    timezone,
  );
  const prevStart = startDt.minus({ days: 1 });
  const prevEnd = startDt.minus({ milliseconds: 1 });
  return {
    start: prevStart.toUTC().toJSDate(),
    end: prevEnd.toUTC().toJSDate(),
  };
}

/**
 * 最近 7 個營運日（含目前營運日起算往前 6 個完整營運日邊界）
 * @param {Date} [now]
 * @returns {{ start: Date, end: Date }}
 */
function getLast7OperationalDaysTimeRange(now = new Date()) {
  const current = getOperationalDayTimeRange(now);
  const { timezone } = getRolloverConfig();
  const startAnchor = DateTime.fromJSDate(current.start, { zone: "utc" }).setZone(
    timezone,
  );
  return {
    start: startAnchor.minus({ days: 6 }).toUTC().toJSDate(),
    end: current.end,
  };
}

/**
 * 往前第 N 個完整營運日（1 = 上一營運日，與 getPreviousOperationalDayTimeRange 相同）
 * @param {number} daysAgo
 * @param {Date} [now]
 * @returns {{ start: Date, end: Date }}
 */
function getOperationalDayRangeDaysAgo(daysAgo, now = new Date()) {
  const n = Math.max(1, Math.trunc(Number(daysAgo) || 1));
  const current = getOperationalDayTimeRange(now);
  const { timezone } = getRolloverConfig();
  const startDt = DateTime.fromJSDate(current.start, { zone: "utc" }).setZone(
    timezone,
  );
  const targetStart = startDt.minus({ days: n });
  const targetEnd = targetStart.plus({ days: 1 }).minus({ milliseconds: 1 });
  return {
    start: targetStart.toUTC().toJSDate(),
    end: targetEnd.toUTC().toJSDate(),
  };
}

module.exports = {
  getOperationalDayTimeRange,
  getPreviousOperationalDayTimeRange,
  getLast7OperationalDaysTimeRange,
  getOperationalDayRangeDaysAgo,
  getRolloverConfig,
};
