/**
 * 統一系統警報輔助函數
 * 為所有系統提供統一的警報創建和管理接口
 * 取代多個系統專用的 helper 文件
 */

const alertService = require("./alertService");
const errorTracker = require("./errorTracker");
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");

/**
 * 從設備配置中提取設備 ID
 * @param {Object} deviceConfig - 設備配置 { host, port, unitId }
 * @returns {Promise<number|null>} 設備 ID
 */
async function getDeviceIdFromConfig(deviceConfig) {
  try {
    if (!deviceConfig || !deviceConfig.host || deviceConfig.port === undefined) {
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

    return result && result.length > 0 ? result[0].id : null;
  } catch (error) {
    console.error("[systemAlertHelper] 從配置提取設備 ID 失敗:", error);
    return null;
  }
}

/**
 * 獲取環境位置資訊
 * @param {number} locationId - 環境位置 ID
 * @returns {Promise<Object|null>} 位置資訊
 */
async function getLocationInfo(locationId) {
  try {
    const result = await db.query(
      `SELECT el.id, el.name, el.device_id, ef.name as floor_name
      FROM environment_locations el
      INNER JOIN environment_floors ef ON el.floor_id = ef.id
      WHERE el.id = ?`,
      [locationId]
    );
    return result && result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error(`[systemAlertHelper] 獲取環境位置資訊失敗:`, error);
    return null;
  }
}

/**
 * 獲取照明區域資訊
 * @param {number} areaId - 照明區域 ID
 * @returns {Promise<Object|null>} 區域資訊
 */
async function getAreaInfo(areaId) {
  try {
    const result = await db.query(
      `SELECT la.id, la.name, 
       (la.modbus_config->>'deviceId')::integer as device_id,
       lf.name as floor_name
      FROM lighting_areas la
      INNER JOIN lighting_floors lf ON la.floor_id = lf.id
      WHERE la.id = ?`,
      [areaId]
    );
    return result && result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error(`[systemAlertHelper] 獲取照明區域資訊失敗:`, error);
    return null;
  }
}

/**
 * 獲取設備資訊
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<Object|null>} 設備資訊
 */
async function getDeviceInfo(deviceId) {
  try {
    const result = await db.query(
      `SELECT d.id, d.name, dt.code as device_type_code, dt.name as device_type_name
      FROM devices d
      INNER JOIN device_types dt ON d.type_id = dt.id
      WHERE d.id = ?`,
      [deviceId]
    );
    return result && result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error(`[systemAlertHelper] 獲取設備資訊失敗:`, error);
    return null;
  }
}

/**
 * 判斷是否為設備連接錯誤
 * @param {string} errorMessage - 錯誤訊息
 * @returns {boolean} 是否為設備連接錯誤
 */
function isDeviceConnectionError(errorMessage) {
  const connectionErrorKeywords = [
    "連接超時",
    "連接被拒絕",
    "無法到達設備",
    "連接已斷開",
    "無法連接",
    "無法讀取",
    "timeout",
    "connection refused",
    "ECONNREFUSED",
    "ETIMEDOUT",
  ];

  const lowerMessage = errorMessage.toLowerCase();
  return connectionErrorKeywords.some((keyword) =>
    lowerMessage.includes(keyword.toLowerCase())
  );
}

/**
 * 從環境位置獲取設備 ID
 * @param {number} locationId - 環境位置 ID
 * @returns {Promise<number|null>} 設備 ID
 */
async function getDeviceIdFromLocation(locationId) {
  try {
    const result = await db.query(
      `SELECT device_id FROM environment_locations WHERE id = ?`,
      [locationId]
    );
    return result && result.length > 0 ? result[0].device_id : null;
  } catch (error) {
    console.error(`[systemAlertHelper] 從環境位置獲取設備 ID 失敗:`, error);
    return null;
  }
}

/**
 * 從照明區域獲取設備 ID
 * @param {number} areaId - 照明區域 ID
 * @returns {Promise<number|null>} 設備 ID
 */
async function getDeviceIdFromArea(areaId) {
  try {
    const result = await db.query(
      `SELECT (modbus_config->>'deviceId')::integer as device_id 
       FROM lighting_areas 
       WHERE id = ?
         AND modbus_config IS NOT NULL
         AND modbus_config != '{}'::jsonb
         AND modbus_config->>'deviceId' IS NOT NULL`,
      [areaId]
    );
    return result && result.length > 0 ? result[0].device_id : null;
  } catch (error) {
    console.error(`[systemAlertHelper] 從照明區域獲取設備 ID 失敗:`, error);
    return null;
  }
}

/**
 * 系統配置
 */
const SYSTEM_CONFIGS = {
  environment: {
    source: alertService.ALERT_SOURCES.ENVIRONMENT,
    getSourceInfo: getLocationInfo,
    getDeviceId: getDeviceIdFromLocation,
  },
  lighting: {
    source: alertService.ALERT_SOURCES.LIGHTING,
    getSourceInfo: getAreaInfo,
    getDeviceId: getDeviceIdFromArea,
  },
  device: {
    source: alertService.ALERT_SOURCES.DEVICE,
    getSourceInfo: getDeviceInfo,
    getDeviceId: async (id) => id, // 設備 ID 就是自己
  },
};

/**
 * 記錄系統錯誤
 * @param {string} system - 系統名稱 (environment, lighting, device)
 * @param {number} sourceId - 來源實體 ID
 * @param {string} errorMessage - 錯誤訊息
 * @param {Object} options - 選項
 * @param {boolean} options.skipWebSocket - 是否跳過 WebSocket 推送（用於批次模式）
 * @returns {Promise<boolean>} 是否創建了警報
 */
async function recordError(system, sourceId, errorMessage, options = {}) {
  try {
    const config = SYSTEM_CONFIGS[system];
    if (!config) {
      throw new Error(`未知的系統: ${system}`);
    }

    // 判斷錯誤類型
    if (isDeviceConnectionError(errorMessage)) {
      // 設備連接錯誤 → 嘗試創建設備警報
      const deviceId = await config.getDeviceId(sourceId);
      if (deviceId) {
        // 獲取設備資訊
        const deviceInfo = await getDeviceInfo(deviceId);
        if (deviceInfo) {
          // 創建設備警報
          const alertCreated = await errorTracker.recordError(
            alertService.ALERT_SOURCES.DEVICE,
            deviceId,
            "offline",
            errorMessage,
            {
              name: deviceInfo.name,
            }
          );

          // 推送 WebSocket 事件：設備離線（批次模式可跳過）
          if (alertCreated && !options.skipWebSocket) {
            websocketService.emitDeviceStatus("device", deviceId, "offline");
          }

          return alertCreated;
        }
      }
      // 如果找不到設備 ID 或設備資訊，降級為系統警報
    }

    // 系統業務錯誤或找不到設備 → 創建系統警報
    const sourceInfo = await config.getSourceInfo(sourceId);
    if (!sourceInfo) {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          `[systemAlertHelper] ⚠️  ${system} 來源 ID ${sourceId} 不存在，跳過錯誤記錄`
        );
      }
      return false;
    }

    const alertType = isDeviceConnectionError(errorMessage) ? "offline" : "error";

    // 記錄錯誤並創建警報（如果達到閾值）
    const alertCreated = await errorTracker.recordError(
      config.source,
      sourceId,
      alertType,
      errorMessage,
      {
        name: sourceInfo.name,
        floor_name: sourceInfo.floor_name,
      }
    );

    // 推送 WebSocket 事件：系統設備離線（僅當創建了 offline 類型的警報時，批次模式可跳過）
    // 注意：這裡的設備狀態推送與警報創建是分離的，確保即使警報未創建也能推送狀態
    if (alertCreated && alertType === "offline" && !options.skipWebSocket) {
      websocketService.emitDeviceStatus(config.source, sourceId, "offline");
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[systemAlertHelper] 📢 已推送設備狀態 | ${config.source}:${sourceId} | offline`
        );
      }
    }

    return alertCreated;
  } catch (error) {
    console.error(
      `[systemAlertHelper] 記錄 ${system} 錯誤失敗 (sourceId: ${sourceId}):`,
      error
    );
    return false;
  }
}

/**
 * 清除系統錯誤狀態
 * @param {string} system - 系統名稱
 * @param {number} sourceId - 來源實體 ID
 * @param {Object} options - 選項
 * @param {boolean} options.skipWebSocket - 是否跳過 WebSocket 推送（用於批次模式）
 * @returns {Promise<void>}
 */
async function clearError(system, sourceId, options = {}) {
  try {
    const config = SYSTEM_CONFIGS[system];
    if (!config) {
      throw new Error(`未知的系統: ${system}`);
    }

    // 清除設備錯誤狀態（如果適用）
    // 注意：只有在非 device 系統時才需要清除設備錯誤
    // 因為 recordError 可能會創建設備警報（如果找到 deviceId）
    if (system !== "device") {
      const deviceId = await config.getDeviceId(sourceId);
      if (deviceId) {
        // 判斷錯誤類型：如果是連接錯誤，則解決 offline 類型警報
        const deviceCleared = await errorTracker.clearError(
          alertService.ALERT_SOURCES.DEVICE,
          deviceId,
          "offline" // 設備恢復連接時，解決 offline 類型警報
        );
        // 只有在實際清除了錯誤時才推送事件（批次模式可跳過）
        if (deviceCleared && !options.skipWebSocket) {
          websocketService.emitDeviceStatus("device", deviceId, "online");
        }
      }
    }

    // 清除系統錯誤狀態（自動解決 offline 和 error 類型警報）
    const systemCleared = await errorTracker.clearError(config.source, sourceId);
    // 只有在實際清除了錯誤時才推送事件（批次模式可跳過）
    if (systemCleared && !options.skipWebSocket) {
      websocketService.emitDeviceStatus(config.source, sourceId, "online");
    }
  } catch (error) {
    console.error(
      `[systemAlertHelper] 清除 ${system} 錯誤狀態失敗 (sourceId: ${sourceId}):`,
      error
    );
  }
}

/**
 * 創建系統警報
 * @param {string} system - 系統名稱
 * @param {number} sourceId - 來源實體 ID
 * @param {string} alertType - 警報類型
 * @param {string} severity - 嚴重程度
 * @param {string} message - 警報訊息
 * @returns {Promise<Object>} 創建的警報
 */
async function createAlert(system, sourceId, alertType, severity, message) {
  try {
    const config = SYSTEM_CONFIGS[system];
    if (!config) {
      throw new Error(`未知的系統: ${system}`);
    }

    // 驗證來源存在
    const sourceInfo = await config.getSourceInfo(sourceId);
    if (!sourceInfo) {
      throw new Error(`${system} 來源 ID ${sourceId} 不存在`);
    }

    // 創建警報
    return await alertService.createAlert({
      source: config.source,
      source_id: sourceId,
      alert_type: alertType,
      severity,
      message,
    });
  } catch (error) {
    console.error(
      `[systemAlertHelper] 創建 ${system} 警報失敗 (sourceId: ${sourceId}):`,
      error
    );
    throw error;
  }
}

module.exports = {
  recordError,
  clearError,
  createAlert,
  getDeviceIdFromConfig,
  // 導出輔助函數供內部使用
  getLocationInfo,
  getAreaInfo,
  getDeviceInfo,
  isDeviceConnectionError,
};

