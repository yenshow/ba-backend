/**
 * 共用時間範圍工具
 * 「今日」等語意以營運日為準（ALERT_DAILY_ROLLOVER_*），見 services/entryExit/operationalDayRange.js
 */
const {
  getOperationalDayTimeRange,
  getPreviousOperationalDayTimeRange,
  getLast7OperationalDaysTimeRange,
} = require("../services/entryExit/operationalDayRange");

/**
 * @deprecated 請用 getOperationalDayTimeRange
 * @returns {{ start: Date, end: Date }}
 */
function getTodayTimeRange() {
  return getOperationalDayTimeRange();
}

/**
 * @deprecated 請用 getPreviousOperationalDayTimeRange
 */
function getYesterdayTimeRange() {
  return getPreviousOperationalDayTimeRange();
}

/**
 * @deprecated 請用 getLast7OperationalDaysTimeRange
 */
function getLast7DaysTimeRange() {
  return getLast7OperationalDaysTimeRange();
}

/**
 * 將 API 的 timeRange/startTime/endTime 寫入 filters 的 startKey/endKey，未指定時預設營運日
 * timeRange 支援：today、yesterday、last7days
 */
function applyDefaultTimeFilters(filters, startKey, endKey) {
  const applyToday = () => {
    const { start, end } = getOperationalDayTimeRange();
    filters[startKey] = start.toISOString();
    filters[endKey] = end.toISOString();
  };
  const applyYesterday = () => {
    const { start, end } = getPreviousOperationalDayTimeRange();
    filters[startKey] = start.toISOString();
    filters[endKey] = end.toISOString();
  };
  const applyLast7Days = () => {
    const { start, end } = getLast7OperationalDaysTimeRange();
    filters[startKey] = start.toISOString();
    filters[endKey] = end.toISOString();
  };
  if (!filters.timeRange && !filters.startTime && !filters.endTime)
    applyToday();
  if (filters.timeRange) {
    if (filters.timeRange === "today") applyToday();
    else if (filters.timeRange === "yesterday") applyYesterday();
    else if (filters.timeRange === "last7days") applyLast7Days();
    else applyToday();
    delete filters.timeRange;
  }
  if (filters.startTime) {
    filters[startKey] = filters.startTime;
    delete filters.startTime;
  }
  if (filters.endTime) {
    filters[endKey] = filters.endTime;
    delete filters.endTime;
  }
}

module.exports = {
  getTodayTimeRange,
  getYesterdayTimeRange,
  getLast7DaysTimeRange,
  getOperationalDayTimeRange,
  getPreviousOperationalDayTimeRange,
  getLast7OperationalDaysTimeRange,
  applyDefaultTimeFilters,
};
