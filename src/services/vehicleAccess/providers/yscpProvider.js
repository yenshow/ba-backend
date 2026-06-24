/**
 * YSCP 車輛進出（外部 vehiclebiz.passageway_log_data）
 */
const handlerFactory = require("../../externalData/handlerFactory");
const { vehicleAccess: yscpVehicleFeature } = require("../../../utils/yscpSystemFeature");
const { normalizePlate } = require("../../../utils/vehiclePlateUtils");
const { computeTransitionStats } = require("../../entryExit/stats");
const {
  resolveStatsTimeRange,
  resolveTimeOptions,
  ENTRY_EXIT_MAX_RECORDS,
} = require("../../entryExit/resolveTimeOptions");
const { normalizeVehicleDirection } = require("../normalizeVehicleDirection");
const logger = require("../../../utils/logger");

function getLaneIds(config) {
  const ids = [];
  if (config.entryLaneId != null) ids.push(Number(config.entryLaneId));
  if (config.exitLaneId != null) ids.push(Number(config.exitLaneId));
  return ids.filter((n) => Number.isFinite(n));
}

async function listPassageLogsForStats(filters) {
  const handler = handlerFactory.getHandler("vehiclebiz", "passageway_log_data");
  const result = await handler.getList({
    ...filters,
    limit: ENTRY_EXIT_MAX_RECORDS,
    offset: 0,
    orderBy: "trigger_time",
    orderDirection: "ASC",
    allow_result: 1,
  });
  if (!result.success) return [];
  const data = result.data || [];
  if (data.length >= ENTRY_EXIT_MAX_RECORDS) {
    logger.warn("YSCP 車輛統計紀錄達上限，結果可能不完整", {
      limit: ENTRY_EXIT_MAX_RECORDS,
      module: "yscpVehicleProvider",
    });
  }
  return data;
}

async function getSiteStats(siteId, config, options = {}) {
  if (yscpVehicleFeature.shouldSkipYscp("yscp")) {
    return yscpVehicleFeature.emptySiteStats();
  }
  const laneIds = getLaneIds(config);
  if (laneIds.length === 0) {
    return { entryCount: 0, exitCount: 0, currentCount: 0 };
  }
  const { start, end } = resolveStatsTimeRange(options);
  const logs = await listPassageLogsForStats({
    lane_id: laneIds,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  });
  return computeTransitionStats(logs, {
    getKey: (r) => normalizePlate(r.license_plate),
    getDirection: normalizeVehicleDirection,
    getTime: (r) => r.trigger_time,
    sortByTime: false,
  });
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
    const { startTime, endTime } = resolveTimeOptions({});
    filters.startTime = startTime;
    filters.endTime = endTime;
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
