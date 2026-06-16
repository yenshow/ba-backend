/**
 * 電梯系統地點管理與事件查詢服務
 * location_type = 'elevator'；事件來源 ladder_sdk_events
 */
const locationService = require("../location/locationService");
const sdkEventService = require("../ladderSdk/sdkEventService");
const sdkArmingService = require("../ladderSdk/sdkArmingService");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const {
  throwApiError,
  rethrowIfApiError,
  causeDetails,
} = require("../../utils/apiErrorMeta");
const { normalizeLogDisplayColumns } = require("./logDisplayColumns");
const {
  validateElevatorFloorConfig,
  normalizeElevatorFloorConfig,
  mapElevatorLogsFloorDisplay,
} = require("./elevatorFloorConfig");
const { resolveTimeOptions } = require("../entryExit/resolveTimeOptions");
const { formatAcsEventDisplayName } = require("../ladderSdk/acsEventLabels");
const { aggregateElevatorLogs } = require("./elevatorLogAggregation");
const db = require("../../database/db");

const MAX_LOG_RECORDS = 500;
/** 最新紀錄先多抓原始事件再合併，避免遠端操作被刷卡連續事件擠出 */
const LATEST_LOG_RAW_FETCH_MIN = 50;

async function refreshElevatorArming() {
  try {
    await sdkArmingService.refresh();
  } catch (_e) {}
}

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

function getElevatorSystem(location) {
  return ensureArray(location?.systems).find(
    (sys) => sys.systemType === "elevator",
  );
}

function getElevatorConfig(location) {
  const sys = getElevatorSystem(location);
  const config = sys?.config || {};
  const deviceIds = Array.isArray(config.deviceIds)
    ? config.deviceIds
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const accessDeviceIds = Array.isArray(config.accessDeviceIds)
    ? config.accessDeviceIds
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const floors = normalizeElevatorFloorConfig(config);
  return {
    deviceIds,
    accessDeviceIds,
    logDisplayColumns: normalizeLogDisplayColumns(config.logDisplayColumns),
    floorCount: floors.floorCount ?? undefined,
    floorNames: floors.floorNames,
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

/** 批次統計今日事件（依 device_id），供 getSites 一次查詢（對齊人流 getSitesData 批次模式） */
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

function validateLocationData(locationData, isUpdate = false) {
  const { name, zoneId, deviceIds, floorCount, floorNames } = locationData;
  if (!isUpdate && !name?.trim()) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "地點名稱不能為空");
  }
  if (!isUpdate && !zoneId) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "區域 ID 不能為空");
  }
  if (deviceIds !== undefined) {
    const ids = ensureArray(deviceIds)
      .map((id) => Number(id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) {
      throwApiError(C.ELEVATOR_VALIDATION_FAILED, "請綁定梯控設備");
    }
    validateElevatorFloorConfig({ deviceIds: ids, floorCount, floorNames });
  }
}

async function getElevatorLocations(options = {}) {
  return handleServiceError(
    async () => {
      const { zoneId } = options;
      const result = await locationService.getZones({
        locationType: "elevator",
      });
      const zones = result.zones;
      if (zoneId) {
        const zone = zones.find((z) => String(z.id) === String(zoneId));
        return { locations: ensureArray(zone?.locations) };
      }
      return {
        locations: zones.flatMap((zone) => ensureArray(zone.locations)),
      };
    },
    "取得電梯地點列表失敗",
    { options },
  );
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

async function createElevatorLocation(locationData, userId) {
  return handleServiceError(
    async () => {
      const {
        name,
        zoneId,
        deviceIds = [],
        accessDeviceIds = [],
        logDisplayColumns,
        floorCount,
        floorNames,
      } = locationData;
      validateLocationData(locationData, false);

      const result = await locationService.createLocation(
        {
          zoneId: parseInt(zoneId, 10),
          name: name.trim(),
          locationType: "elevator",
          config: {
            deviceIds,
            accessDeviceIds,
            logDisplayColumns,
            floorCount,
            floorNames,
          },
        },
        userId,
      );

      await refreshElevatorArming();

      return {
        message: "電梯地點建立成功",
        location: result.location,
      };
    },
    "建立電梯地點失敗",
    { userId },
  );
}

async function updateElevatorLocation(id, locationData, userId) {
  return handleServiceError(
    async () => {
      const {
        name,
        deviceIds,
        accessDeviceIds,
        logDisplayColumns,
        floorCount,
        floorNames,
      } = locationData;
      await getElevatorLocationById(id);
      validateLocationData(locationData, true);

      const updates = {};
      if (name !== undefined) updates.name = name.trim();

      const configUpdates = {};
      if (deviceIds !== undefined) configUpdates.deviceIds = deviceIds;
      if (accessDeviceIds !== undefined) {
        configUpdates.accessDeviceIds = accessDeviceIds;
      }
      if (logDisplayColumns !== undefined) {
        configUpdates.logDisplayColumns = logDisplayColumns;
      }
      if (floorCount !== undefined) configUpdates.floorCount = floorCount;
      if (floorNames !== undefined) configUpdates.floorNames = floorNames;
      if (Object.keys(configUpdates).length > 0) {
        updates.config = configUpdates;
      }

      const result = await locationService.updateLocation(
        id,
        {
          ...updates,
          locationType: "elevator",
        },
        userId,
      );

      await refreshElevatorArming();

      return {
        message: "電梯地點更新成功",
        location: result.location,
      };
    },
    "更新電梯地點失敗",
    { id, userId },
  );
}

async function deleteElevatorLocation(id) {
  return handleServiceError(
    async () => {
      await getElevatorLocationById(id);
      const result = await locationService.deleteLocation(id);
      await refreshElevatorArming();
      return result;
    },
    "刪除電梯地點失敗",
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
      const { deviceIds } = getElevatorConfig(location);
      return { locationId, name: location.name, deviceIds };
    });

    const allDeviceIds = locationEntries.flatMap((entry) => entry.deviceIds);
    const countByDeviceId = await countTodayEventsByDeviceIds(allDeviceIds);

    const sites = locationEntries.map(({ locationId, name, deviceIds }) => ({
      id: locationId,
      name,
      deviceIds,
      todayEventCount: deviceIds.reduce(
        (sum, deviceId) => sum + (countByDeviceId.get(deviceId) ?? 0),
        0,
      ),
    }));
    return { sites };
  }, "取得電梯地點列表失敗");
}

async function getSiteLogs(locationId, options = {}) {
  return handleServiceError(
    async () => {
      const { deviceIds, floorNames } = await getSiteConfig(locationId);
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
      const needsAggregationBuffer =
        offsetNum === 0 && limitNum <= 20;
      const rawFetchLimit = needsAggregationBuffer
        ? Math.min(
            Math.max(limitNum * 10, LATEST_LOG_RAW_FETCH_MIN),
            MAX_LOG_RECORDS,
          )
        : limitNum;

      const primaryDeviceId = deviceIds[0];
      const result = await sdkEventService.listEvents({
        deviceId: primaryDeviceId,
        limit: rawFetchLimit,
        offset: offsetNum,
        startTime: resolved.startTime,
        endTime: resolved.endTime,
      });

      let logs = (result.items || []).map(mapEventToLog);
      logs = filterLogsBySearch(logs, search);
      logs = aggregateElevatorLogs(logs);
      logs = mapElevatorLogsFloorDisplay(logs, floorNames);
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

module.exports = {
  MAX_LOG_RECORDS,
  getElevatorLocations,
  getElevatorLocationById,
  createElevatorLocation,
  updateElevatorLocation,
  deleteElevatorLocation,
  getSites,
  getSiteLogs,
  getAllSiteLogs,
  getElevatorConfig,
};
