/**
 * 環境系統警報輔助函數
 * 為環境系統提供統一的警報創建接口
 */

const alertService = require("../alertService");
const { createSystemAlert, recordSystemError, clearSystemError } = require("./alertHelperBase");
const db = require("../../database/db");

/**
 * 獲取環境位置資訊
 * @param {number} locationId - 環境位置 ID
 * @returns {Promise<Object|null>} 位置資訊
 */
async function getLocationInfo(locationId) {
	const location = await db.query(
		`SELECT el.id, el.name, ef.name as floor_name
		FROM environment_locations el
		INNER JOIN environment_floors ef ON el.floor_id = ef.id
		WHERE el.id = ?`,
		[locationId]
	);

	return location && location.length > 0 ? location[0] : null;
}

/**
 * 創建環境系統警報
 * @param {number} locationId - 環境位置 ID
 * @param {string} alertType - 警報類型
 * @param {string} severity - 嚴重程度
 * @param {string} message - 警報訊息
 * @param {Object} metadata - 額外資訊
 * @returns {Promise<Object>} 創建的警報
 */
async function createEnvironmentAlert(locationId, alertType, severity, message, metadata = {}) {
	return await createSystemAlert(
		alertService.ALERT_SOURCES.ENVIRONMENT,
		locationId,
		"location",
		getLocationInfo,
		alertType,
		severity,
		message,
		metadata
	);
}

/**
 * 記錄環境系統錯誤
 * @param {number} locationId - 環境位置 ID
 * @param {string} errorMessage - 錯誤訊息
 * @returns {Promise<boolean>} 是否創建了警報
 */
async function recordEnvironmentError(locationId, errorMessage) {
	return await recordSystemError(
		alertService.ALERT_SOURCES.ENVIRONMENT,
		locationId,
		"location",
		getLocationInfo,
		errorMessage
	);
}

/**
 * 清除環境系統錯誤狀態
 * @param {number} locationId - 環境位置 ID
 * @returns {Promise<void>}
 */
async function clearEnvironmentError(locationId) {
	return await clearSystemError(alertService.ALERT_SOURCES.ENVIRONMENT, locationId);
}

module.exports = {
	createEnvironmentAlert,
	recordEnvironmentError,
	clearEnvironmentError
};

