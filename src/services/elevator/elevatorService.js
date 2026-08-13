/**
 * 電梯系統地點管理與事件查詢服務
 */
const locationService = require("../location/locationService");
const sdkEventService = require("../ladderSdk/sdkEventService");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const {
  throwApiError,
  rethrowIfApiError,
  causeDetails,
} = require("../../utils/apiErrors");
const {
  getElevatorConfigFromLocation,
  mapElevatorLogsFloorDisplay,
} = require("./elevatorFloorModel");
const elevatorRuntimeService = require("./elevatorRuntimeService");
const { resolveTimeOptions } = require("../entryExit/resolveTimeOptions");
const { formatAcsEventDisplayName } = require("../ladderSdk/acsEventLabels");
const { aggregateElevatorLogs } = require("./elevatorLogAggregation");
const db = require("../../database/db");

const MAX_LOG_RECORDS = 500;
const LATEST_LOG_RAW_FETCH_MIN = 50;

async function handleServiceError(fn, errorMessage, context = {}) {
  try {
    return await fn();
  } catch (error) {
    rethrowIfApiError(error);
    logger.error(errorMessage, {
      error,
      ...context,
      module: "elevatorService",
    });
    throwApiError(C.ELEVATOR_OPERATION_FAILED, errorMessage, {
      statusCode: 500,
      details: causeDetails(error),
    });
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeId(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getElevatorConfig(location) {
  const config = getElevatorConfigFromLocation(location);
  return {
    accessDeviceIds: config.accessDeviceIds ?? [],
    floors: config.floors ?? [],
    panel: config.panel,
    ladderDevice: config.ladderDevice,
    callDevice: config.callDevice,
    floorDetection: config.floorDetection,
    callCommandType: config.callCommandType ?? "visitor",
  };
}

async function getSiteConfig(locationId) {
  const { location } = await getElevatorLocationById(locationId);
  return getElevatorConfig(location);
}

function mapEventToLog(row) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    major: row.major,
    minor: row.minor,
    floor: row.floor ?? null,
    deviceName: row.deviceName || null,
    personName: row.personName || null,
    event: formatAcsEventDisplayName(row.eventName, row.major, row.minor),
    time: row.eventTime,
    employeeNo: row.employeeNo || null,
    personId: row.personId || null,
  };
}

function filterLogsBySearch(logs, search) {
  const q = search != null ? String(search).trim().toLowerCase() : "";
  if (!q) return logs;
  return logs.filter((log) => {
    const name =
      log.personName != null ? String(log.personName).toLowerCase() : "";
    const emp =
      log.employeeNo != null ? String(log.employeeNo).toLowerCase() : "";
    return name.includes(q) || emp.includes(q);
  });
}

function getTodayRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

async function countTodayEventsByDeviceIds(deviceIds) {
  const ids = [
    ...new Set(
      ensureArray(deviceIds)
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
  const countByDeviceId = new Map();
  if (ids.length === 0) return countByDeviceId;

  const { startTime, endTime } = getTodayRange();
  const rows = await db.query(
    `SELECT device_id, COUNT(*)::int AS total
     FROM ladder_sdk_events
     WHERE device_id = ANY(?::int[])
       AND event_time >= ?
       AND event_time <= ?
     GROUP BY device_id`,
    [ids, startTime, endTime],
  );

  for (const row of rows || []) {
    const deviceId = Number(row.device_id);
    if (!Number.isFinite(deviceId)) continue;
    countByDeviceId.set(deviceId, Number(row.total) || 0);
  }
  return countByDeviceId;
}

async function getElevatorLocationById(id) {
  return handleServiceError(
    async () => {
      const locationResult = await locationService.getLocationById(id);
      const location = locationResult.location;
      const hasElevator = ensureArray(location.systems).some(
        (sys) => sys.systemType === "elevator",
      );
      if (!hasElevator) {
        throwApiError(C.ELEVATOR_VALIDATION_FAILED, "地點類型不正確");
      }
      return { location };
    },
    "取得電梯地點失敗",
    { id },
  );
}

async function getSites() {
  return handleServiceError(async () => {
    const locationsResult = await locationService.getZones({
      locationType: "elevator",
    });
    const allLocations = ensureArray(locationsResult.zones).flatMap((zone) =>
      ensureArray(zone.locations),
    );
    if (allLocations.length === 0) return { sites: [] };

    const locationEntries = allLocations.map((location) => {
      const locationId = normalizeId(location.id);
      const cfg = getElevatorConfig(location);
      return { locationId, name: location.name, location, cfg };
    });

    const allDeviceIds = locationEntries
      .map((entry) => entry.cfg.ladderDevice?.deviceId)
      .filter((id) => id != null);
    const countByDeviceId = await countTodayEventsByDeviceIds(allDeviceIds);

    const sites = locationEntries.map(({ locationId, name, cfg }) => {
      const live = elevatorRuntimeService.getPublicRuntime(locationId);
      const ladderDeviceId = cfg.ladderDevice?.deviceId ?? null;
      return {
        id: locationId,
        name,
        ladderDevice: cfg.ladderDevice ?? null,
        callDevice: cfg.callDevice ?? null,
        floors: cfg.floors,
        panel: cfg.panel,
        todayEventCount: ladderDeviceId
          ? countByDeviceId.get(ladderDeviceId) ?? 0
          : 0,
        live,
      };
    });
    return { sites };
  }, "取得電梯地點列表失敗");
}

async function getSiteLogs(locationId, options = {}) {
  return handleServiceError(
    async () => {
      const { ladderDevice, callDevice, floors } = await getSiteConfig(locationId);
      const deviceIds = [ladderDevice?.deviceId, callDevice?.deviceId]
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (!deviceIds.length) return { logs: [], total: 0 };

      const {
        limit = 50,
        offset = 0,
        startTime,
        endTime,
        timeRange,
        search,
      } = options;

      const resolved = resolveTimeOptions({ startTime, endTime, timeRange });
      const limitNum = Math.min(
        Math.max(Number(limit) || 50, 1),
        MAX_LOG_RECORDS,
      );
      const offsetNum = Math.max(Number(offset) || 0, 0);
      const needsAggregationBuffer = offsetNum === 0 && limitNum <= 20;
      const rawFetchLimit = needsAggregationBuffer
        ? Math.min(
            Math.max(limitNum * 10, LATEST_LOG_RAW_FETCH_MIN),
            MAX_LOG_RECORDS,
          )
        : limitNum;

      const result = await sdkEventService.listEvents({
        deviceIds,
        limit: rawFetchLimit,
        offset: offsetNum,
        startTime: resolved.startTime,
        endTime: resolved.endTime,
      });

      let logs = (result.items || []).map(mapEventToLog);
      logs = filterLogsBySearch(logs, search);
      logs = aggregateElevatorLogs(logs);
      logs = mapElevatorLogsFloorDisplay(logs, floors);
      if (needsAggregationBuffer && logs.length > limitNum) {
        logs = logs.slice(0, limitNum);
      }

      return {
        logs,
        total: search ? logs.length : result.total,
        limit: limitNum,
        offset: offsetNum,
      };
    },
    "取得電梯事件紀錄失敗",
    { locationId, options },
  );
}

async function getAllSiteLogs(options = {}) {
  return handleServiceError(
    async () => {
      const {
        siteId: filterSiteId,
        search,
        limit,
        offset,
        ...timeOpts
      } = options;
      const globalLimit = Math.min(
        Math.max(Number(limit) || MAX_LOG_RECORDS, 1),
        MAX_LOG_RECORDS,
      );
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const locationsResult = await locationService.getZones({
        locationType: "elevator",
      });
      let allLocations = ensureArray(locationsResult.zones).flatMap((zone) =>
        ensureArray(zone.locations),
      );

      if (filterSiteId != null && filterSiteId !== "") {
        const sid = normalizeId(filterSiteId);
        allLocations = allLocations.filter(
          (loc) => normalizeId(loc.id) === sid,
        );
      }

      const merged = [];
      for (const loc of allLocations) {
        const locationId = normalizeId(loc.id);
        const { logs } = await getSiteLogs(locationId, {
          ...timeOpts,
          limit: MAX_LOG_RECORDS,
          offset: 0,
          search,
        });
        for (const log of logs || []) {
          merged.push({ ...log, locationId });
        }
      }

      merged.sort((a, b) => {
        const ta = a.time ? new Date(a.time).getTime() : 0;
        const tb = b.time ? new Date(b.time).getTime() : 0;
        return tb - ta;
      });

      const sliced = merged.slice(offsetNum, offsetNum + globalLimit);
      return {
        logs: sliced,
        total: merged.length,
        limit: globalLimit,
        offset: offsetNum,
      };
    },
    "取得跨地點電梯事件紀錄失敗",
    { options },
  );
}

async function getSiteLiveState(locationId) {
  const { location } = await getElevatorLocationById(locationId);
  return elevatorRuntimeService.pollLocationRuntime(location);
}

module.exports = {
  MAX_LOG_RECORDS,
  getElevatorLocationById,
  getSites,
  getSiteLogs,
  getAllSiteLogs,
  getElevatorConfig,
  getSiteLiveState,
};
