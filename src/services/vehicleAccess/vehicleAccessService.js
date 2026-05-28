/**
 * 車輛進出服務（yscp | isapi_camera）
 */
/** 延遲載入，避免 locationSystemOps ↔ vehicleAccessService 循環依賴 */
const getLocationService = () => require("../location/locationService");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const { parseConfig } = require("./vehicleAccessValidation");
const yscpProvider = require("./providers/yscpProvider");
const isapiCameraProvider = require("./providers/isapiCameraProvider");
const isapiVehicleSubscribeService = require("./isapiVehicleSubscribeService");
const yscpVehicleFeature = require("../../utils/yscpVehicleAccessFeature");
const { ENTRY_EXIT_MAX_RECORDS } = require("../entryExit/resolveTimeOptions");
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
  return {
    dataSource: cfg.dataSource === "isapi_camera" ? "isapi_camera" : "yscp",
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
  return { location, ...getVehicleAccessConfig(location) };
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
      const provider = getProvider(cfg.dataSource);
      const stats = await provider.getSiteStats(siteId, cfg, {});
      sites.push({
        id: siteId,
        name: loc.name,
        zoneName: zone.name,
        dataSource: cfg.dataSource,
        entryCount: stats.entryCount,
        exitCount: stats.exitCount,
        currentCount: stats.currentCount,
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

async function getSiteLogs(siteId, options = {}) {
  const { dataSource, ...cfg } = await getSiteConfig(siteId);
  const provider = getProvider(dataSource);
  const { logs, total } = await provider.getSiteLogs(siteId, cfg, options);
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

module.exports = {
  getSites,
  getSiteStats,
  getSiteLogs,
  getAllSiteLogs,
  getSiteConfig,
  getVehicleAccessConfig,
  refreshSubscribeAfterLocationChange,
  normalizeId,
};
