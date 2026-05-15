const logger = require("../../utils/logger");
const { FIXED_DEVICE_TYPES } = require("../../constants/deviceTypes");
const { rethrowIfApiError, failDeviceTypeList } = require("../../utils/deviceErrors");

const deviceTypeLogger = logger.createLogger("deviceTypeService");

async function getAllDeviceTypes() {
  try {
    return { device_types: FIXED_DEVICE_TYPES };
  } catch (error) {
    rethrowIfApiError(error);
    deviceTypeLogger.error("取得設備類型失敗", {
      error: error?.message || String(error),
      module: "deviceTypeService",
    });
    failDeviceTypeList("取得設備類型失敗: " + error.message, error.message);
  }
}

module.exports = {
  getAllDeviceTypes,
};
