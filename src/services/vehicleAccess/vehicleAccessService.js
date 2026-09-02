/**
 * 車輛進出服務（yscp | isapi_camera）
 */
/** 延遲載入，避免 locationSystemOps ↔ vehicleAccessService 循環依賴 */
const getLocationService = () => require("../location/locationService");
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const {
  getEffectiveSince,
  parseVehicleAccessConfigFields,
} = require("./vehicleAccessConfig");
const yscpProvider = require("./providers/yscpProvider");
const isapiCameraProvider = require("./providers/isapiCameraProvider");
const { vehicleAccess: yscpVehicleFeature } = require("../../utils/yscpSystemFeature");
const { ENTRY_EXIT_MAX_RECORDS } = require("../entryExit/resolveTimeOptions");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { normalizeVehicleDirection } = require("./vehicleAccessHelpers");
const { performLocationStatsReset } = require("../entryExit/locationStatsReset");
const websocketService = require("../websocket/websocketService");
const logger = require("../../utils/logger");

const PROVIDERS = {
  yscp: yscpProvider,
  isapi_camera: isapiCameraProvider,
};

function getProvider(dataSource) {
  return PROVIDERS[dataSource === "isapi_camera" ? "isapi_camera" : "yscp"];
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function getVehicleAccessConfig(location) {
  const sys = ensureArray(location.systems).find(
    (s) => s.systemType === "vehicle_access",
  );
  const cfg = sys?.config || {};
  const modeFields = parseVehicleAccessConfigFields(cfg);
  return {
    dataSource: cfg.dataSource === "isapi_camera" ? "isapi_camera" : "yscp",
    operationMode: modeFields.operationMode,
    statsEpochStartedAt: modeFields.statsEpochStartedAt,
    statsResetAt: modeFields.statsResetAt,
    parkingCapacity: modeFields.parkingCapacity,
    entryLaneId: cfg.entryLaneId ?? cfg.entry_lane_id ?? null,
    exitLaneId: cfg.exitLaneId ?? cfg.exit_lane_id ?? null,
    entryCameraDeviceIds: ensureArray(cfg.entryCameraDeviceIds),
    exitCameraDeviceIds: ensureArray(cfg.exitCameraDeviceIds),
    cameraChannelId: cfg.cameraChannelId ?? 1,
  };
}

async function getSiteConfig(siteId) {
  const { location } = await getLocationService().getLocationById(siteId);
  if (!location) throwApiError(C.LOCATION_NOT_FOUND, "地點不存在");
  const hasVa = ensureArray(location.systems).some(
    (s) => s.systemType === "vehicle_access",
  );
  if (!hasVa) {
    throwApiError(C.VEHICLE_ACCESS_VALIDATION_FAILED, "地點未設定車輛進出系統");
  }
  const vaCfg = getVehicleAccessConfig(location);
  const createdAt =
    location.createdAt != null
      ? location.createdAt
      : location.created_at != null
        ? new Date(location.created_at).toISOString()
        : null;
  return { location, createdAt, ...vaCfg };
}

function resolveLogTimeOptions(cfg, createdAt, options = {}) {
  if (options.since) {
    return { ...options, since: String(options.since), useSinceOnly: true };
  }
  if (cfg.operationMode === "parking" && !options.startTime && !options.timeRange) {
    const since = getEffectiveSince(cfg, createdAt);
    if (since) return { ...options, since, useSinceOnly: true };
  }
  return { ...options, useSinceOnly: false };
}

async function getSites() {
  const result = await getLocationService().getZones({
    locationType: "vehicle_access",
  });
  const sites = [];
  for (const zone of ensureArray(result.zones)) {
    for (const loc of ensureArray(zone.locations)) {
      const cfg = getVehicleAccessConfig(loc);
      if (yscpVehicleFeature.shouldSkipYscp(cfg.dataSource)) continue;
      const siteId = Number(loc.id);
      if (!Number.isFinite(siteId)) continue;

      let entryCount = 0;
      let exitCount = 0;
      let currentCount = 0;
      if (cfg.operationMode === "parking" && cfg.dataSource === "isapi_camera") {
        const session = await getSiteSessionStats(siteId);
        entryCount = session.entryCount;
        exitCount = session.exitCount;
        currentCount = session.currentCount;
      } else {
        const provider = getProvider(cfg.dataSource);
        const stats = await provider.getSiteStats(siteId, cfg, {
          timeRange: "today",
        });
        entryCount = stats.entryCount;
        exitCount = stats.exitCount;
        currentCount = stats.currentCount;
      }

      sites.push({
        id: siteId,
        name: loc.name,
        zoneName: zone.name,
        dataSource: cfg.dataSource,
        operationMode: cfg.operationMode,
        entryCount,
        exitCount,
        currentCount,
      });
    }
  }
  return { sites };
}

async function getSiteStats(siteId, options = {}) {
  const { dataSource, ...cfg } = await getSiteConfig(siteId);
  const provider = getProvider(dataSource);
  return provider.getSiteStats(siteId, cfg, options);
}

async function loadSessionReleasedRows(siteId, since) {
  if (!since) return [];
  const rows = await db.query(
    `SELECT license_plate, allow_result, lane_type, trigger_time
     FROM vehicle_passageway_logs
     WHERE location_id = ? AND data_source = 'isapi_camera'
       AND trigger_time > ?
       AND allow_result = 1 AND lane_type IN (1, 2)
     ORDER BY trigger_time ASC`,
    [siteId, since],
  );
  return rows || [];
}

/**
 * Session 放行 logs 單次掃描：進／出計數 + 在場車牌（與 computeTransitionStats 同口徑）
 * @param {Array<{ license_plate?: string, lane_type?: number|null, allow_result?: number, trigger_time?: * }>} rows
 */
function computeSessionFromReleasedRows(rows) {
  /** @type {Map<string, 'entry'|'exit'>} */
  const lastByPlate = new Map();
  let entryCount = 0;
  let exitCount = 0;

  for (const row of rows || []) {
    const plate = normalizePlate(row.license_plate);
    if (!plate) continue;
    const dir = normalizeVehicleDirection(row);
    if (dir !== "entry" && dir !== "exit") continue;

    const prev = lastByPlate.get(plate);
    if (prev === undefined && dir === "exit") continue;
    if (prev !== dir) {
      if (dir === "entry") entryCount += 1;
      else exitCount += 1;
    }
    lastByPlate.set(plate, dir);
  }

  const presentPlates = [];
  for (const [plate, dir] of lastByPlate) {
    if (dir === "entry") presentPlates.push(plate);
  }
  presentPlates.sort((a, b) => a.localeCompare(b));

  return {
    entryCount,
    exitCount,
    currentCount: presentPlates.length,
    presentPlates,
  };
}

/**
 * @returns {Promise<
 *   | { ok: false, capacity: number|null }
 *   | { ok: true, entryCount: number, exitCount: number, currentCount: number, presentPlates: string[], since: string|null, capacity: number|null }
 * >}
 */
async function tryLoadParkingSession(siteId) {
  const siteCfg = await getSiteConfig(siteId);
  const capacity =
    siteCfg.operationMode === "parking" ? siteCfg.parkingCapacity : null;
  if (
    siteCfg.operationMode !== "parking" ||
    siteCfg.dataSource !== "isapi_camera"
  ) {
    return { ok: false, capacity };
  }

  const since = getEffectiveSince(siteCfg, siteCfg.createdAt);
  if (!since) {
    return {
      ok: true,
      entryCount: 0,
      exitCount: 0,
      currentCount: 0,
      presentPlates: [],
      since: null,
      capacity,
    };
  }

  const rows = await loadSessionReleasedRows(siteId, since);
  const computed = computeSessionFromReleasedRows(rows);
  return { ok: true, ...computed, since, capacity };
}

async function getSiteSessionStats(siteId) {
  const session = await tryLoadParkingSession(siteId);
  if (!session.ok) {
    throwApiError(
      C.VEHICLE_ACCESS_VALIDATION_FAILED,
      "僅停車場 ISAPI 模式可使用 session 統計",
    );
  }
  return {
    entryCount: session.entryCount,
    exitCount: session.exitCount,
    currentCount: session.currentCount,
    capacity: session.capacity,
    since: session.since,
  };
}

async function getSitePresence(siteId) {
  const session = await tryLoadParkingSession(siteId);
  if (!session.ok) {
    return { currentCount: 0, capacity: session.capacity };
  }
  return {
    currentCount: session.currentCount,
    capacity: session.capacity,
  };
}

async function getSitePresencePlates(siteId) {
  const session = await tryLoadParkingSession(siteId);
  if (!session.ok) return { plates: [] };
  return { plates: session.presentPlates };
}

async function resetSiteStats(siteId, userId = null) {
  const { operationMode } = await getSiteConfig(siteId);
  if (operationMode !== "parking") {
    throwApiError(
      C.VEHICLE_ACCESS_VALIDATION_FAILED,
      "僅停車場模式可重置統計",
    );
  }

  const resetAt = await performLocationStatsReset({
    systemType: "vehicle_access",
    scope: "vehicle_access",
    locationId: siteId,
    notFoundMessage: "地點未設定車輛進出系統",
    userId,
  });

  const { invalidateLocationIngestCache } = require("./isapiVehiclePersistence");
  invalidateLocationIngestCache(siteId);
  websocketService.emitVehicleAccessIsapiEvent({
    type: "stats_reset",
    locationId: Number(siteId),
  });

  return { statsResetAt: resetAt };
}

async function getSiteLogs(siteId, options = {}) {
  const { dataSource, createdAt, ...cfg } = await getSiteConfig(siteId);
  const provider = getProvider(dataSource);
  const timeOpts = resolveLogTimeOptions(cfg, createdAt, options);
  const { logs, total } = await provider.getSiteLogs(siteId, cfg, timeOpts);
  return { logs, total, dataSource };
}

const ALL_SITE_LOGS_CONCURRENCY = 5;

function filterLogsBySearch(logs, search) {
  const q = search != null ? String(search).trim().toLowerCase() : "";
  if (!q) return logs;
  return logs.filter((log) => {
    const plate =
      log.license_plate != null ? String(log.license_plate).trim().toLowerCase() : "";
    const owner =
      log.owner_name != null ? String(log.owner_name).trim().toLowerCase() : "";
    return plate.includes(q) || owner.includes(q);
  });
}

/**
 * 跨地點過車紀錄（完整報表）
 */
async function getAllSiteLogs(options = {}) {
  const { siteId: filterSiteId, search, limit, offset, ...timeOpts } = options;
  const globalLimit = Math.min(
    Math.max(Number(limit) || ENTRY_EXIT_MAX_RECORDS, 1),
    ENTRY_EXIT_MAX_RECORDS,
  );
  const offsetNum = Math.max(Number(offset) || 0, 0);

  const result = await getLocationService().getZones({
    locationType: "vehicle_access",
  });
  let allLocations = [];
  for (const zone of ensureArray(result.zones)) {
    for (const loc of ensureArray(zone.locations)) {
      allLocations.push(loc);
    }
  }

  if (filterSiteId != null && filterSiteId !== "") {
    const sid = Number(filterSiteId);
    allLocations = allLocations.filter((loc) => Number(loc.id) === sid);
  }

  const siteIds = [];
  for (const loc of allLocations) {
    const cfg = getVehicleAccessConfig(loc);
    if (yscpVehicleFeature.shouldSkipYscp(cfg.dataSource)) continue;
    const siteId = Number(loc.id);
    if (Number.isFinite(siteId)) siteIds.push(siteId);
  }

  const perSiteOpts = {
    ...timeOpts,
    limit: ENTRY_EXIT_MAX_RECORDS,
    offset: 0,
  };

  const merged = [];
  for (let i = 0; i < siteIds.length; i += ALL_SITE_LOGS_CONCURRENCY) {
    const batch = siteIds.slice(i, i + ALL_SITE_LOGS_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (siteId) => {
        const { logs } = await getSiteLogs(siteId, perSiteOpts);
        return (logs || []).map((log) => ({ ...log, locationId: siteId }));
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        merged.push(...r.value);
      } else {
        logger.warn("跨地點過車紀錄：單站查詢失敗", {
          error: r.reason?.message || r.reason,
          module: "vehicleAccessService",
        });
      }
    }
  }

  merged.sort(
    (a, b) =>
      new Date(b.trigger_time || 0).getTime() -
      new Date(a.trigger_time || 0).getTime(),
  );

  const filtered = filterLogsBySearch(merged, search);
  return { logs: filtered.slice(offsetNum, offsetNum + globalLimit) };
}

async function getOrganizationGroups(siteId, options = {}) {
  const { dataSource, operationMode } = await getSiteConfig(siteId);
  if (dataSource !== "isapi_camera") {
    return { groups: [] };
  }
  const vehicleOrganizationGroupsService = require("./vehicleOrganizationGroupsService");
  let presentPlates;
  if (operationMode === "parking") {
    try {
      const presence = await getSitePresencePlates(siteId);
      presentPlates = presence.plates ?? [];
    } catch {
      presentPlates = [];
    }
  }
  return vehicleOrganizationGroupsService.getOrganizationGroupsForSite(siteId, {
    ...options,
    presentPlates,
  });
}

module.exports = {
  getSites,
  getSiteStats,
  getSiteSessionStats,
  getSitePresence,
  getSitePresencePlates,
  resetSiteStats,
  getSiteLogs,
  getAllSiteLogs,
  getSiteConfig,
  getVehicleAccessConfig,
  getOrganizationGroups,
};
