/**
 * YSCP 車輛進出（外部 vehiclebiz.passageway_log_data）
 */
const handlerFactory = require("../../externalData/handlerFactory");
const { getTodayTimeRange } = require("../../../utils/dateRangeUtils");
const yscpVehicleFeature = require("../../../utils/yscpVehicleAccessFeature");

function ensureIntArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function getLaneIds(config) {
  const ids = [];
  if (config.entryLaneId != null) ids.push(Number(config.entryLaneId));
  if (config.exitLaneId != null) ids.push(Number(config.exitLaneId));
  return ids.filter((n) => Number.isFinite(n));
}

async function countLogs(filters) {
  const handler = handlerFactory.getHandler("vehiclebiz", "passageway_log_data");
  const result = await handler.getCount(filters);
  const raw = result.data;
  return typeof raw === "number" ? raw : Number(raw?.count ?? 0);
}

async function getSiteStats(siteId, config, timeRange) {
  if (yscpVehicleFeature.shouldSkipYscp("yscp")) {
    return yscpVehicleFeature.emptySiteStats();
  }
  const laneIds = getLaneIds(config);
  if (laneIds.length === 0) {
    return { entryCount: 0, exitCount: 0, currentCount: 0 };
  }
  const base = { lane_id: laneIds, allow_result: 1, ...timeRange };
  const [entryCount, exitCount] = await Promise.all([
    countLogs({ ...base, lane_type: 1 }),
    countLogs({ ...base, lane_type: 2 }),
  ]);
  return {
    entryCount,
    exitCount,
    currentCount: Math.max(0, entryCount - exitCount),
  };
}

async function getSiteLogs(siteId, config, options = {}) {
  if (yscpVehicleFeature.shouldSkipYscp("yscp")) {
    return { logs: [], total: 0 };
  }
  const laneIds = getLaneIds(config);
  if (laneIds.length === 0) return { logs: [], total: 0 };
  const handler = handlerFactory.getHandler("vehiclebiz", "passageway_log_data");
  const {
    limit = 50,
    offset = 0,
    startTime,
    endTime,
    timeRange,
    search,
  } = options;
  const filters = {
    lane_id: laneIds,
    limit,
    offset,
    orderBy: "trigger_time",
    orderDirection: "DESC",
  };
  if (startTime && endTime) {
    filters.startTime = startTime;
    filters.endTime = endTime;
  } else if (timeRange) {
    filters.timeRange = timeRange;
  } else {
    const today = getTodayTimeRange();
    filters.startTime = today.start.toISOString();
    filters.endTime = today.end.toISOString();
  }
  if (search) filters.search = search;

  const [listResult, countResult] = await Promise.all([
    handler.getList(filters),
    handler.getCount({
      ...filters,
      limit: undefined,
      offset: undefined,
      orderBy: undefined,
      orderDirection: undefined,
    }),
  ]);
  const logs = listResult.data || [];
  const total =
    typeof countResult.data === "number"
      ? countResult.data
      : Number(countResult.data?.count ?? logs.length);
  return { logs, total };
}

module.exports = {
  getSiteStats,
  getSiteLogs,
  getLaneIds,
};
