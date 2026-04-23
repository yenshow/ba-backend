const logger = require("../../utils/logger");
const { FIXED_DEVICE_TYPES } = require("../../constants/deviceTypes");

const deviceTypeLogger = logger.createLogger("deviceTypeService");

// 取得所有設備類型
async function getAllDeviceTypes() {
	try {
		// 設備類型固定：不查 DB，直接回固定四筆
		return { device_types: FIXED_DEVICE_TYPES };
	} catch (error) {
		deviceTypeLogger.error("取得設備類型失敗", {
			error: error?.message || String(error),
			module: "deviceTypeService",
		});
		throw new Error("取得設備類型失敗: " + error.message);
	}
}

module.exports = {
	getAllDeviceTypes,
};
