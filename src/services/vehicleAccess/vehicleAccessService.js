/**
 * 車輛進出服務（yscp | isapi_camera）
 */
/** 延遲載入，避免 locationSystemOps ↔ vehicleAccessService 循環依賴 */
const getLocationService = () => require("../location/locationService");
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const { parseConfig } = require("./vehicleAccessValidation");
const {
  getEffectiveSince,
  parseVehicleAccessConfigFields,
} = require("./vehicleAccessConfig");
const yscpProvider = require("./providers/yscpProvider");
const isapiCameraProvider = require("./providers/isapiCameraProvider");
const isapiVehicleSubscribeService = require("./isapiVehicleSubscribeService");
const vehiclePresenceService = require("./vehiclePresenceService");
const yscpVehicleFeature = require("../../utils/yscpVehicleAccessFeature");
const { ENTRY_EXIT_MAX_RECORDS } = require("../entryExit/resolveTimeOptions");
const { computeTransitionStats } = require("../entryExit/stats");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { normalizeVehicleDirection } = require("./normalizeVehicleDirection");
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

function normalizeId(id) {
  return id != null ? String(id) : "";
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
    entryLaneId: cfg.entryLaneId ?? null,
    exitLaneId: cfg.exitLaneId ?? null,
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
    throwApiError(C.PEOPLE_COUNTING_VALIDATION_FAILED, "地點未設定車輛進出系統");
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
    return { since: String(options.since), useSinceOnly: true };
  }
  if (cfg.operationMode === "parking" && !options.startTime && !options.timeRange) {
    const since = getEffectiveSince(cfg, createdAt);
    if (since) return { since, useSinceOnly: true };
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
        const presence = await getSitePresence(siteId);
        currentCount = presence.currentCount;
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

async function getSiteSessionStats(siteId) {
  const { dataSource, operationMode, createdAt, ...cfg } =
    await getSiteConfig(siteId);
  if (operationMode !== "parking") {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "僅停車場模式可使用 session 統計",
    );
  }
  if (dataSource !== "isapi_camera") {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "停車場 session 統計僅支援 ISAPI",
    );
  }
  const since = getEffectiveSince(cfg, createdAt);
  if (!since) {
    return { entryCount: 0, exitCount: 0, since: null };
  }
  const rows = await db.query(
    `SELECT license_plate, allow_result, lane_type, trigger_time
     FROM vehicle_passageway_logs
     WHERE location_id = ? AND data_source = 'isapi_camera'
       AND trigger_time > ?
       AND allow_result = 1 AND lane_type IN (1, 2)
     ORDER BY trigger_time ASC`,
    [siteId, since],
  );
  const stats = computeTransitionStats(rows || [], {
    getKey: (r) => normalizePlate(r.license_plate),
    getDirection: normalizeVehicleDirection,
    getTime: (r) => r.trigger_time,
    sortByTime: false,
  });
  return {
    entryCount: stats.entryCount,
    exitCount: stats.exitCount,
    since,
  };
}

async function getSitePresence(siteId) {
  const { operationMode, parkingCapacity } = await getSiteConfig(siteId);
  const currentCount = await vehiclePresenceService.getPresenceCount(siteId);
  return {
    currentCount,
    capacity: operationMode === "parking" ? parkingCapacity : null,
  };
}

async function getSitePresencePlates(siteId) {
  await getSiteConfig(siteId);
  const plates = await vehiclePresenceService.getPresentPlates(siteId);
  return { plates };
}

async function resetSiteStats(siteId, userId = null) {
  const { operationMode } = await getSiteConfig(siteId);
  if (operationMode !== "parking") {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "僅停車場模式可重製統計",
    );
  }

  const resetAt = new Date().toISOString();
  const rows = await db.query(
    `SELECT id, system_config FROM location_systems
     WHERE location_id = ? AND system_type = 'vehicle_access'`,
    [siteId],
  );
  if (!rows?.length) {
    throwApiError(C.PEOPLE_COUNTING_VALIDATION_FAILED, "地點未設定車輛進出系統");
  }

  const rawCfg =
    typeof rows[0].system_config === "string"
      ? JSON.parse(rows[0].system_config)
      : rows[0].system_config || {};
  rawCfg.stats_reset_at = resetAt;
  await db.query(
    `UPDATE location_systems
     SET system_config = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(rawCfg), rows[0].id],
  );

  await vehiclePresenceService.resetPresence(siteId);
  const { invalidateLocationIngestCache } = require("./isapiVehiclePersistence");
  invalidateLocationIngestCache(siteId);

  if (userId != null) {
    await db.query(
      `INSERT INTO vehicle_access_reset_log (location_id, reset_at, user_id)
       VALUES (?, ?, ?)`,
      [siteId, resetAt, userId],
    );
  }

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

async function refreshSubscribeAfterLocationChange() {
  try {
    await isapiVehicleSubscribeService.refresh();
  } catch (_e) {}
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
      presentPlates = presence?.plates;
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
  refreshSubscribeAfterLocationChange,
  normalizeId,
};
