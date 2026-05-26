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

async function refreshSubscribeAfterLocationChange() {
  try {
    await isapiVehicleSubscribeService.refresh();
  } catch (_e) {}
}

module.exports = {
  getSites,
  getSiteStats,
  getSiteLogs,
  getSiteConfig,
  getVehicleAccessConfig,
  refreshSubscribeAfterLocationChange,
  normalizeId,
};
