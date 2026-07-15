/**
 * YSCP 車輛進出（外部 vehiclebiz.passageway_log_data）
 * 統計／logs 直接查 external DB（與人流 YSCP provider 相同，不受 external-data handler maxLimit 限制）
 */
const externalDb = require("../../../database/externalDb");
const PassagewayLogDataHandler = require("../../externalData/handlers/passagewayLogDataHandler");
const { vehicleAccess: yscpVehicleFeature } = require("../../../utils/yscpSystemFeature");
const { normalizePlate } = require("../../../utils/vehiclePlateUtils");
const { computeTransitionStats } = require("../../entryExit/stats");
const {
  resolveStatsTimeRange,
  ENTRY_EXIT_MAX_RECORDS,
} = require("../../entryExit/resolveTimeOptions");
const { createVehicleDirectionResolver } = require("../vehicleAccessHelpers");
const logger = require("../../../utils/logger");

const passageMapper = new PassagewayLogDataHandler();
const SEARCH_COLUMNS = passageMapper.getSearchableColumns();

function getLaneIds(config) {
  const ids = [];
  const entry = config.entryLaneId ?? config.entry_lane_id;
  const exit = config.exitLaneId ?? config.exit_lane_id;
  if (entry != null) ids.push(Number(entry));
  if (exit != null) ids.push(Number(exit));
  return [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))];
}

function mapRows(rows) {
  return (rows || []).map((row) => passageMapper.mapItemToOutput(row));
}

function appendSearchFilter(search, params) {
  const q = search != null ? String(search).trim() : "";
  if (!q) return "";
  const term = `%${q}%`;
  const parts = SEARCH_COLUMNS.map((col) => {
    params.push(term);
    return `p.${col}::text ILIKE $${params.length}`;
  });
  return ` AND (${parts.join(" OR ")})`;
}

/** @returns {{ laneSql: string, searchSql: string, startIdx: number, endIdx: number }} */
function buildPassageFilters(laneIds, start, end, search, params) {
  const placeholders = laneIds.map((_, i) => `$${params.length + 1 + i}`).join(", ");
  laneIds.forEach((id) => params.push(id));
  const laneSql = `p.lane_id IN (${placeholders})`;
  const searchSql = appendSearchFilter(search, params);
  params.push(start.toISOString());
  const startIdx = params.length;
  params.push(end.toISOString());
  const endIdx = params.length;
  return { laneSql, searchSql, startIdx, endIdx };
}

function resolveLogTimeRange(options = {}) {
  if (options.useSinceOnly && options.since) {
    return { start: new Date(options.since), end: new Date() };
  }
  if (options.startTime && options.endTime) {
    return resolveStatsTimeRange({
      startTime: options.startTime,
      endTime: options.endTime,
    });
  }
  if (options.timeRange) {
    return resolveStatsTimeRange({ timeRange: options.timeRange });
  }
  return resolveStatsTimeRange({});
}

async function queryPassageLogs(options) {
  const {
    laneIds,
    start,
    end,
    search,
    orderDirection = "DESC",
    limit = null,
    offset = 0,
  } = options;
  const params = [];
  const { laneSql, searchSql, startIdx, endIdx } = buildPassageFilters(
    laneIds,
    start,
    end,
    search,
    params,
  );
  const order = orderDirection === "ASC" ? "ASC" : "DESC";

  let limitSql = "";
  if (limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0) {
    params.push(Math.trunc(Number(limit)));
    limitSql = ` LIMIT $${params.length}`;
    const offsetNum = Math.max(0, Math.trunc(Number(offset) || 0));
    if (offsetNum > 0) {
      params.push(offsetNum);
      limitSql += ` OFFSET $${params.length}`;
    }
  }

  const sql = `
    SELECT p.*, li.lane_type
    FROM vehiclebiz.passageway_log_data p
    LEFT JOIN vehiclebiz.lane_info li ON p.lane_id = li.id
    WHERE ${laneSql}
      AND p.allow_result = 1
      AND p.trigger_time >= $${startIdx} AND p.trigger_time <= $${endIdx}
      ${searchSql}
    ORDER BY p.trigger_time ${order}
    ${limitSql}
  `;
  return externalDb.query(sql, params);
}

async function countPassageLogs(laneIds, start, end, search) {
  const params = [];
  const { laneSql, searchSql, startIdx, endIdx } = buildPassageFilters(
    laneIds,
    start,
    end,
    search,
    params,
  );

  const sql = `
    SELECT COUNT(*)::int AS count
    FROM vehiclebiz.passageway_log_data p
    WHERE ${laneSql}
      AND p.allow_result = 1
      AND p.trigger_time >= $${startIdx} AND p.trigger_time <= $${endIdx}
      ${searchSql}
  `;
  const rows = await externalDb.query(sql, params);
  return Number(rows?.[0]?.count ?? 0);
}

async function listPassageLogsForStats(laneIds, start, end) {
  const rows = await queryPassageLogs({
    laneIds,
    start,
    end,
    orderDirection: "ASC",
    limit: ENTRY_EXIT_MAX_RECORDS,
    offset: 0,
  });
  if (rows.length >= ENTRY_EXIT_MAX_RECORDS) {
    logger.warn("YSCP 車輛統計紀錄達上限，結果可能不完整", {
      limit: ENTRY_EXIT_MAX_RECORDS,
      module: "yscpVehicleProvider",
    });
  }
  return mapRows(rows);
}

async function getSiteStats(_siteId, config, options = {}) {
  if (yscpVehicleFeature.shouldSkipYscp("yscp")) {
    return yscpVehicleFeature.emptySiteStats();
  }
  const laneIds = getLaneIds(config);
  if (laneIds.length === 0) {
    return { entryCount: 0, exitCount: 0, currentCount: 0 };
  }
  const { start, end } = resolveStatsTimeRange(options);
  const logs = await listPassageLogsForStats(laneIds, start, end);
  const getDirection = createVehicleDirectionResolver(
    config.entryLaneId ?? config.entry_lane_id,
    config.exitLaneId ?? config.exit_lane_id,
  );
  return computeTransitionStats(logs, {
    getKey: (r) => normalizePlate(r.license_plate),
    getDirection,
    getTime: (r) => r.trigger_time,
    sortByTime: false,
  });
}

async function getSiteLogs(_siteId, config, options = {}) {
  if (yscpVehicleFeature.shouldSkipYscp("yscp")) {
    return { logs: [], total: 0 };
  }
  const laneIds = getLaneIds(config);
  if (laneIds.length === 0) return { logs: [], total: 0 };

  const { limit = 50, offset = 0, search } = options;
  const { start, end } = resolveLogTimeRange(options);
  const limitNum = Math.min(
    Math.max(Number(limit) || 50, 1),
    ENTRY_EXIT_MAX_RECORDS,
  );
  const offsetNum = Math.max(Number(offset) || 0, 0);

  const [rows, total] = await Promise.all([
    queryPassageLogs({
      laneIds,
      start,
      end,
      search,
      orderDirection: "DESC",
      limit: limitNum,
      offset: offsetNum,
    }),
    countPassageLogs(laneIds, start, end, search),
  ]);

  return { logs: mapRows(rows), total };
}

module.exports = {
  getSiteStats,
  getSiteLogs,
  getLaneIds,
};
