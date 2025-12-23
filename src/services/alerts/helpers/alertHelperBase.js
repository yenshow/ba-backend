/**
 * 警報輔助函數基礎類
 * 提供共用的輔助函數，減少重複代碼
 */

const alertService = require("./alertService");
const errorTracker = require("./errorTracker");

/**
 * 創建系統警報（通用函數）
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @param {string} sourceType - 來源類型
 * @param {Function} getSourceInfo - 獲取來源資訊的函數
 * @param {string} alertType - 警報類型
 * @param {string} severity - 嚴重程度
 * @param {string} message - 警報訊息
 * @param {Object} metadata - 額外資訊
 * @returns {Promise<Object>} 創建的警報
 */
async function createSystemAlert(
	source,
	sourceId,
	sourceType,
	getSourceInfo,
	alertType,
	severity,
	message,
	metadata = {}
) {
	try {
		// 獲取來源資訊
		const sourceInfo = await getSourceInfo(sourceId);
		if (!sourceInfo) {
			throw new Error(`${source} 來源 ID ${sourceId} 不存在`);
		}

		// 構建 metadata
		const fullMetadata = {
			[`${sourceType}_name`]: sourceInfo.name,
			floor_name: sourceInfo.floor_name,
			...metadata
		};

		return await alertService.createAlert({
			source,
			source_id: sourceId,
			source_type: sourceType,
			alert_type: alertType,
			severity,
			message,
			metadata: fullMetadata
		});
	} catch (error) {
		console.error(`[alertHelperBase] 創建 ${source} 警報失敗:`, error);
		throw error;
	}
}

/**
 * 記錄系統錯誤（通用函數）
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @param {string} sourceType - 來源類型
 * @param {Function} getSourceInfo - 獲取來源資訊的函數
 * @param {string} errorMessage - 錯誤訊息
 * @returns {Promise<boolean>} 是否創建了警報
 */
async function recordSystemError(source, sourceId, sourceType, getSourceInfo, errorMessage) {
	try {
		// 獲取來源資訊
		const sourceInfo = await getSourceInfo(sourceId);
		if (!sourceInfo) {
			console.warn(`[alertHelperBase] ${source} 來源 ID ${sourceId} 不存在`);
			return false;
		}

		return await errorTracker.recordError(
			source,
			sourceId,
			"offline",
			errorMessage,
			{
				name: sourceInfo.name,
				type: sourceType,
				floor_name: sourceInfo.floor_name
			}
		);
	} catch (error) {
		console.error(`[alertHelperBase] 記錄 ${source} 錯誤失敗:`, error);
		return false;
	}
}

/**
 * 清除系統錯誤狀態（通用函數）
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @returns {Promise<void>}
 */
async function clearSystemError(source, sourceId) {
	return await errorTracker.clearError(source, sourceId);
}

module.exports = {
	createSystemAlert,
	recordSystemError,
	clearSystemError
};

