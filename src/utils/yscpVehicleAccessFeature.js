/**
 * YSCP 車輛進出資料源功能旗標（ENABLE_YSCP_VEHICLE_ACCESS + License vehicle_access）
 */

const config = require("../config");
const systemMapping = require("../services/externalData/systemMapping");
const effectiveFeaturesCache = require("../services/license/effectiveFeaturesCache");

const isLicenseGranted = () =>
  effectiveFeaturesCache.hasCachedLicensedFeature("vehicle_access");

const isEnabled = () =>
  config.features?.enableYscpVehicleAccess !== false && isLicenseGranted();

const shouldSkipYscp = (dataSource) =>
  dataSource === "yscp" && !isEnabled();

const isBlockedExternalTable = (schema, table) =>
  !isEnabled() &&
  systemMapping.getSystemsByTable(schema, table).includes("vehicle_access");

const emptyExternalListResult = (limit = 50, offset = 0) => ({
  success: true,
  data: [],
  pagination: { limit, offset, count: 0 },
});

const emptyExternalCountResult = () => ({ success: true, count: 0 });

const emptySiteStats = () => ({
  entryCount: 0,
  exitCount: 0,
  currentCount: 0,
});

const emptyVehicleGroups = () => ({ groups: [] });

module.exports = {
  isEnabled,
  shouldSkipYscp,
  isBlockedExternalTable,
  emptyExternalListResult,
  emptyExternalCountResult,
  emptySiteStats,
  emptyVehicleGroups,
};
