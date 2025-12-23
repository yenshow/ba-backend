/**
 * 照明系統警報輔助函數
 * 為照明系統提供統一的警報創建接口
 */

const alertService = require("../alertService");
const { createSystemAlert, recordSystemError, clearSystemError } = require("./alertHelperBase");
const db = require("../../database/db");

/**
 * 獲取照明區域資訊
 * @param {number} areaId - 照明區域 ID
 * @returns {Promise<Object|null>} 區域資訊
 */
async function getAreaInfo(areaId) {
	const area = await db.query(
		`SELECT la.id, la.name, lf.name as floor_name
		FROM lighting_areas la
		INNER JOIN lighting_floors lf ON la.floor_id = lf.id
		WHERE la.id = ?`,
		[areaId]
	);

	return area && area.length > 0 ? area[0] : null;
}

/**
 * 創建照明系統警報
 * @param {number} areaId - 照明區域 ID
 * @param {string} alertType - 警報類型
 * @param {string} severity - 嚴重程度
 * @param {string} message - 警報訊息
 * @param {Object} metadata - 額外資訊
 * @returns {Promise<Object>} 創建的警報
 */
async function createLightingAlert(areaId, alertType, severity, message, metadata = {}) {
	return await createSystemAlert(
		alertService.ALERT_SOURCES.LIGHTING,
		areaId,
		"area",
		getAreaInfo,
		alertType,
		severity,
		message,
		metadata
	);
}

/**
 * 記錄照明系統錯誤
 * @param {number} areaId - 照明區域 ID
 * @param {string} errorMessage - 錯誤訊息
 * @returns {Promise<boolean>} 是否創建了警報
 */
async function recordLightingError(areaId, errorMessage) {
	return await recordSystemError(
		alertService.ALERT_SOURCES.LIGHTING,
		areaId,
		"area",
		getAreaInfo,
		errorMessage
	);
}

/**
 * 清除照明系統錯誤狀態
 * @param {number} areaId - 照明區域 ID
 * @returns {Promise<void>}
 */
async function clearLightingError(areaId) {
	return await clearSystemError(alertService.ALERT_SOURCES.LIGHTING, areaId);
}

module.exports = {
	createLightingAlert,
	recordLightingError,
	clearLightingError
};

