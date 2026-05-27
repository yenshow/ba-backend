/**
 * 進出統計時間查詢解析（營運日）
 */
const {
  getOperationalDayTimeRange,
  getPreviousOperationalDayTimeRange,
  getLast7OperationalDaysTimeRange,
} = require("./operationalDayRange");

/** 人流／車輛進出：單次查詢／統計事件上限（SSOT） */
const ENTRY_EXIT_MAX_RECORDS = 10000;

const PRESET_ALIASES = {
  today: "today",
  yesterday: "yesterday",
  last7days: "last7days",
  last_7_days: "last7days",
};

function normalizePreset(preset) {
  const key = String(preset || "today").trim();
  return PRESET_ALIASES[key] || null;
}

function getRangeForPreset(preset = "today") {
  const normalized = normalizePreset(preset) || "today";
  if (normalized === "yesterday") {
    return getPreviousOperationalDayTimeRange();
  }
  if (normalized === "last7days") {
    return getLast7OperationalDaysTimeRange();
  }
  return getOperationalDayTimeRange();
}

/**
 * @param {{ startTime?: string, endTime?: string, timeRange?: string }} query
 * @returns {{ startTime: string, endTime: string, timeRange?: string }}
 */
function resolveTimeOptions(query = {}) {
  const { startTime, endTime, timeRange } = query;
  if (startTime && endTime) {
    return { startTime, endTime };
  }
  const preset = normalizePreset(timeRange) || "today";
  const { start, end } = getRangeForPreset(preset);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    timeRange: preset,
  };
}

/**
 * @param {string} [preset]
 * @returns {{ preset: string, start: string, end: string }}
 */
function getOperationalDayRangeResponse(preset = "today") {
  const normalized = normalizePreset(preset) || "today";
  const { start, end } = getRangeForPreset(normalized);
  return {
    preset: normalized,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

/** stats/logs 用 Date 區間 */
function resolveStatsTimeRange(options = {}) {
  const { startTime, endTime } = resolveTimeOptions(options);
  return {
    start: new Date(startTime),
    end: new Date(endTime),
  };
}

module.exports = {
  ENTRY_EXIT_MAX_RECORDS,
  resolveTimeOptions,
  getOperationalDayRangeResponse,
  normalizePreset,
  getRangeForPreset,
  resolveStatsTimeRange,
};
