/**
 * 統一地點管理服務（多系統架構）— 公開 API 入口
 * 實作拆分：locationShared / locationZoneOps / locationLocationOps / locationSystemOps
 */

const zoneOps = require("./locationZoneOps");
const locationOps = require("./locationLocationOps");

module.exports = {
  getZones: zoneOps.getZones,
  getZoneById: zoneOps.getZoneById,
  createZone: zoneOps.createZone,
  updateZone: zoneOps.updateZone,
  deleteZone: zoneOps.deleteZone,
  loadZoneLocations: zoneOps.loadZoneLocations,
  formatZone: zoneOps.formatZone,
  formatLocation: zoneOps.formatLocation,
  getLocationById: locationOps.getLocationById,
  getPeopleCountingSyncableLocationsWithAccessControlDevices:
    locationOps.getPeopleCountingSyncableLocationsWithAccessControlDevices,
  getVehicleAccessSyncableLocationsWithIsapiCameras:
    locationOps.getVehicleAccessSyncableLocationsWithIsapiCameras,
  createLocation: locationOps.createLocation,
  updateLocation: locationOps.updateLocation,
  deleteLocation: locationOps.deleteLocation,
};
