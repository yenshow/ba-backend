/**
 * 共用時間範圍工具（UTC，與資料庫時區一致）
 */

/**
 * 取得今日時間範圍（UTC 00:00:00 - 23:59:59.999）
 * @returns {{ start: Date, end: Date }}
 */
function getTodayTimeRange() {
  const now = new Date();
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
  return { start, end };
}

/**
 * 取得昨日時間範圍（UTC 00:00:00 - 23:59:59.999）
 * @returns {{ start: Date, end: Date }}
 */
function getYesterdayTimeRange() {
  const now = new Date();
  const yesterday = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 1,
      0,
      0,
      0,
      0,
    ),
  );
  const start = yesterday;
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 1,
      23,
      59,
      59,
      999,
    ),
  );
  return { start, end };
}

/**
 * 取得最近一週時間範圍（今日起算往前 7 個日曆日：start = 6 天前 00:00，end = 今日 23:59:59.999）
 * @returns {{ start: Date, end: Date }}
 */
function getLast7DaysTimeRange() {
  const now = new Date();
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 6,
      0,
      0,
      0,
      0,
    ),
  );
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
  return { start, end };
}

/**
 * 將 API 的 timeRange/startTime/endTime 寫入 filters 的 startKey/endKey，未指定時預設今天
 * timeRange 支援：today、yesterday、last7days
 * @param {Object} filters - 篩選物件（會被修改）
 * @param {string} startKey - 開始時間欄位名（如 trigger_time_start）
 * @param {string} endKey - 結束時間欄位名（如 trigger_time_end）
 */
function applyDefaultTimeFilters(filters, startKey, endKey) {
  const applyToday = () => {
    const { start, end } = getTodayTimeRange();
    filters[startKey] = start.toISOString();
    filters[endKey] = end.toISOString();
  };
  const applyYesterday = () => {
    const { start, end } = getYesterdayTimeRange();
    filters[startKey] = start.toISOString();
    filters[endKey] = end.toISOString();
  };
  const applyLast7Days = () => {
    const { start, end } = getLast7DaysTimeRange();
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
  applyDefaultTimeFilters,
};
