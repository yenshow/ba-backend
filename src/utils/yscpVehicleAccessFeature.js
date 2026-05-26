/**
 * YSCP 車輛進出資料源功能旗標（ENABLE_YSCP_VEHICLE_ACCESS）
 */

const config = require("../config");
const systemMapping = require("../services/externalData/systemMapping");

const isEnabled = () => config.features?.enableYscpVehicleAccess !== false;

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
