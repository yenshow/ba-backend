/**
 * 人流統計地點設定（stats_reset_at）
 */
const { resolveStatsTimeRange } = require("../entryExit/resolveTimeOptions");

/**
 * @param {object} raw - DB snake_case 或 API camelCase
 */
function parsePeopleCountingConfigFields(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const statsResetAt = c.stats_reset_at ?? c.statsResetAt ?? null;
  return {
    statsResetAt: statsResetAt != null ? String(statsResetAt) : null,
  };
}

/**
 * 主畫面統計／logs 起算：max(營運日起點, stats_reset_at)
 * @param {{ start: Date, end: Date }} range
 * @param {string|null|undefined} statsResetAt
 */
function applyStatsResetToTimeRange(range, statsResetAt) {
  if (!statsResetAt) return range;
  const resetMs = new Date(statsResetAt).getTime();
  if (!Number.isFinite(resetMs)) return range;
  if (resetMs > range.start.getTime()) {
    return { start: new Date(resetMs), end: range.end };
  }
  return range;
}

/**
 * @param {object} [options] - startTime, endTime, timeRange
 * @param {string|null|undefined} statsResetAt
 */
function resolvePeopleCountingStatsTimeRange(options = {}, statsResetAt) {
  return applyStatsResetToTimeRange(resolveStatsTimeRange(options), statsResetAt);
}

/** 營運日內 stats_reset_at 是否仍影響目前統計窗口（跨日後自動失效） */
function isStatsResetActive(statsResetAt) {
  if (!statsResetAt) return false;
  const opDay = resolveStatsTimeRange({});
  const effective = resolvePeopleCountingStatsTimeRange({}, statsResetAt);
  return effective.start.getTime() > opDay.start.getTime();
}

/**
 * 主畫面 logs（未傳時間區間）時帶入 reset 起算點
 * @param {{ statsResetAt?: string|null }} cfg
 * @param {object} options
 */
function enrichOptionsWithStatsReset(cfg, options = {}) {
  if (options.startTime || options.endTime || options.timeRange) {
    return options;
  }
  if (!cfg.statsResetAt) return options;
  const { start, end } = resolvePeopleCountingStatsTimeRange(
    {},
    cfg.statsResetAt,
  );
  return {
    ...options,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

module.exports = {
  parsePeopleCountingConfigFields,
  applyStatsResetToTimeRange,
  resolvePeopleCountingStatsTimeRange,
  enrichOptionsWithStatsReset,
  isStatsResetActive,
};
