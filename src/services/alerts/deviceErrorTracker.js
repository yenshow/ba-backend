/**
 * 設備錯誤追蹤服務（適配器）
 * 提供向後兼容的接口，內部使用新的統一錯誤追蹤系統
 */

const errorTracker = require("./errorTracker");
const alertService = require("./alertService");
const db = require("../../database/db");

/**
 * 記錄設備錯誤（適配舊接口）
 * @param {number} deviceId - 設備 ID
 * @param {string} errorType - 錯誤類型 ('offline' 或 'error')
 * @param {string} errorMessage - 錯誤訊息
 * @returns {Promise<boolean>} 是否創建了警報
 */
async function recordDeviceError(deviceId, errorType, errorMessage) {
  try {
    // 獲取設備資訊以構建 metadata
    const deviceResult = await db.query(
      `SELECT d.id, d.name, dt.code as device_type_code, dt.name as device_type_name
			FROM devices d
			INNER JOIN device_types dt ON d.type_id = dt.id
			WHERE d.id = ?`,
      [deviceId]
    );

    if (!deviceResult || deviceResult.length === 0) {
      console.warn(`[deviceErrorTracker] 設備 ID ${deviceId} 不存在`);
      return false;
    }

    const device = deviceResult[0];
    const alertType = "offline"; // 將通訊錯誤整合到離線警報

    return await errorTracker.recordError(
      alertService.ALERT_SOURCES.DEVICE,
      deviceId,
      alertType,
      errorMessage,
      {
        name: device.name,
        type: device.device_type_code,
        device_type_name: device.device_type_name,
      }
    );
  } catch (error) {
    console.error(`[deviceErrorTracker] 記錄設備錯誤失敗:`, error);
    return false;
  }
}

/**
 * 清除設備錯誤狀態（適配舊接口）
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<void>}
 */
async function clearDeviceError(deviceId) {
  return await errorTracker.clearError(
    alertService.ALERT_SOURCES.DEVICE,
    deviceId
  );
}

/**
 * 取得設備錯誤狀態
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<Object|null>} 錯誤狀態
 */
async function getDeviceErrorState(deviceId) {
  const tracking = await errorTracker.getErrorTracking(
    alertService.ALERT_SOURCES.DEVICE,
    deviceId
  );

  if (!tracking || tracking.error_count === 0) {
    return null;
  }

  return {
    count: tracking.error_count,
    lastErrorAt: tracking.last_error_at,
    alertCreated: tracking.alert_created,
    threshold: errorTracker.ERROR_THRESHOLD,
  };
}

/**
 * 從設備配置中提取設備 ID
 * @param {Object} deviceConfig - 設備配置 { host, port, unitId }
 * @returns {Promise<number|null>} 設備 ID
 */
async function getDeviceIdFromConfig(deviceConfig) {
  try {
    if (
      !deviceConfig ||
      !deviceConfig.host ||
      deviceConfig.port === undefined
    ) {
      return null;
    }

    // 查詢匹配的設備
    const result = await db.query(
      `SELECT d.id
			FROM devices d
			INNER JOIN device_types dt ON d.type_id = dt.id
			WHERE d.status = 'active'
				AND (
					(d.config::jsonb->>'protocol' = 'modbus'
						AND (d.config::jsonb->>'host')::text = ?
						AND (d.config::jsonb->>'port')::text = ?)
				)
			LIMIT 1`,
      [deviceConfig.host, String(deviceConfig.port)]
    );

    if (result && result.length > 0) {
      return result[0].id;
    }

    return null;
  } catch (error) {
    console.error("[deviceErrorTracker] 從配置提取設備 ID 失敗:", error);
    return null;
  }
}

module.exports = {
  recordDeviceError,
  clearDeviceError,
  getDeviceErrorState,
  getDeviceIdFromConfig,
  ERROR_THRESHOLD: errorTracker.ERROR_THRESHOLD,
};

