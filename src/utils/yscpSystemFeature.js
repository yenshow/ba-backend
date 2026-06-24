/**
 * YSCP 外部資料庫（ENABLE_YSCP_DATABASE）與各模組資料源旗標
 */

const config = require("../config");
const systemMapping = require("../services/externalData/systemMapping");
const effectiveFeaturesCache = require("../services/license/effectiveFeaturesCache");

const isDatabaseEnabled = () => config.features.enableYscpDatabase;

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

const createYscpSystemFeature = (licenseFeatureKey, extras = {}) => {
  const isLicenseGranted = () =>
    effectiveFeaturesCache.hasCachedLicensedFeature(licenseFeatureKey);

  const isEnabled = () => isDatabaseEnabled() && isLicenseGranted();

  return {
    isEnabled,
    shouldSkipYscp: (dataSource) => dataSource === "yscp" && !isEnabled(),
    isBlockedExternalTable: (schema, table) =>
      !isEnabled() &&
      systemMapping.getSystemsByTable(schema, table).includes(licenseFeatureKey),
    emptyExternalListResult,
    emptyExternalCountResult,
    emptySiteStats,
    ...extras,
  };
};

const peopleCounting = createYscpSystemFeature("people_counting", {
  emptyUnitPersonnel: () => ({
    personnel: [],
    entryCount: 0,
    exitCount: 0,
  }),
});

const vehicleAccess = createYscpSystemFeature("vehicle_access", {
  emptyVehicleGroups: () => ({ groups: [] }),
});

module.exports = {
  isDatabaseEnabled,
  peopleCounting,
  vehicleAccess,
};
