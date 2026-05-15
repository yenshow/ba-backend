/**
 * YSCP 人流資料源功能旗標（ENABLE_YSCP_PEOPLE_COUNTING）
 */

const config = require("../config");
const systemMapping = require("../services/externalData/systemMapping");

const isEnabled = () => config.features?.enableYscpPeopleCounting !== false;

const shouldSkipYscp = (dataSource) =>
  dataSource === "yscp" && !isEnabled();

const isBlockedExternalTable = (schema, table) =>
  !isEnabled() &&
  systemMapping.getSystemsByTable(schema, table).includes("people_counting");

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

const emptyUnitPersonnel = () => ({
  personnel: [],
  entryCount: 0,
  exitCount: 0,
});

module.exports = {
  isEnabled,
  shouldSkipYscp,
  isBlockedExternalTable,
  emptyExternalListResult,
  emptyExternalCountResult,
  emptySiteStats,
  emptyUnitPersonnel,
};
