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
      [deviceConfig.host, String(deviceConfig.port)],
    );

    return result && result.length > 0 ? result[0].id : null;
  } catch (error) {
    console.error("[systemAlertHelper] 從配置提取設備 ID 失敗:", error);
    return null;
  }
}

/**
 * 依系統類型獲取地點/區域資訊（共用查詢，減少重複）
 * @param {number} systemId - 地點系統 ID (location_systems.id)
 * @param {string} systemType - 'environment' | 'lighting'
 * @returns {Promise<Object|null>}
 */
async function getSourceInfoByType(systemId, systemType) {
  try {
    const result = await db.query(
      `SELECT ls.id, ls.system_type,
              COALESCE(ls.system_config->>'device_id', ls.system_config->>'deviceId') as device_id,
              l.name, l.zone_id, z.name as zone_name
       FROM location_systems ls
       INNER JOIN locations l ON ls.location_id = l.id
       INNER JOIN zones z ON l.zone_id = z.id
       WHERE ls.id = ? AND ls.system_type = ?`,
      [systemId, systemType],
    );
    return result && result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error(
      `[systemAlertHelper] 獲取 ${systemType} 來源資訊失敗:`,
      error,
    );
    return null;
  }
}

const getLocationInfo = (systemId) =>
  getSourceInfoByType(systemId, "environment");
const getAreaInfo = (systemId) => getSourceInfoByType(systemId, "lighting");
const getDrainageInfo = (systemId) => getSourceInfoByType(systemId, "drainage");
const getPowerInfo = (systemId) => getSourceInfoByType(systemId, "power");
const getFireInfo = (systemId) => getSourceInfoByType(systemId, "fire");
const getEmergencyRescueInfo = (systemId) =>
  getSourceInfoByType(systemId, "emergency_rescue");

/**
 * 獲取設備資訊
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<Object|null>} 設備資訊
 */
async function getDeviceInfo(deviceId) {
  try {
    const result = await db.query(
      `SELECT d.id, d.name, d.status, dt.code as device_type_code, dt.name as device_type_name
      FROM devices d
      INNER JOIN device_types dt ON d.type_id = dt.id
      WHERE d.id = ?`,
      [deviceId],
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
const CONNECTION_ERROR_KEYWORDS = [
  "連接超時",
  "連接被拒絕",
  "無法到達設備",
  "連接已斷開",
  "無法連接",
  "無法讀取",
  "timeout",
  "connection refused",
  "econnrefused",
  "etimedout",
];

function isDeviceConnectionError(errorMessage) {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return CONNECTION_ERROR_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * 依系統類型從 location_systems 獲取設備 ID（共用查詢）
 * @param {number} systemId - location_systems.id
 * @param {string} systemType - 'environment' | 'lighting'
 * @returns {Promise<number|null>}
 */
async function getDeviceIdFromLocationSystem(systemId, systemType) {
  try {
    const result = await db.query(
      `SELECT COALESCE(
                (system_config->>'device_id')::integer,
                (system_config->>'deviceId')::integer
              ) as device_id
       FROM location_systems
       WHERE id = ? AND system_type = ?
         AND (
           system_config->>'device_id' IS NOT NULL
           OR system_config->>'deviceId' IS NOT NULL
         )`,
      [systemId, systemType],
    );
    return result && result.length > 0 ? result[0].device_id : null;
  } catch (error) {
    console.error(
      `[systemAlertHelper] 從 ${systemType} 取得設備 ID 失敗:`,
      error,
    );
    return null;
  }
}

const getDeviceIdFromLocation = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "environment");
const getDeviceIdFromArea = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "lighting");
const getDeviceIdFromDrainage = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "drainage");
const getDeviceIdFromPower = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "power");
const getDeviceIdFromFire = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "fire");
const getDeviceIdFromEmergencyRescue = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "emergency_rescue");

/**
 * 依設備 ID 與系統類型取得所有對應的 location_systems.id
 * 用於恢復時一併清除同一實體設備在其它地點的警報（避免雙重警報只解一筆）
 * @param {number} deviceId - 設備 ID
 * @param {string} systemType - 系統類型 ('environment' | 'lighting' | 'drainage')
 * @returns {Promise<number[]>} location_systems.id 陣列
 */
async function getLocationSystemIdsByDeviceId(deviceId, systemType) {
  try {
    const result = await db.query(
      `SELECT id FROM location_systems
       WHERE system_type = $1
         AND system_config->>'device_id' IS NOT NULL
         AND (system_config->>'device_id')::integer = $2`,
      [systemType, deviceId],
    );
    return (result || []).map((r) => r.id);
  } catch (error) {
    console.error(
      `[systemAlertHelper] 依設備取得 location_systems 失敗 (deviceId: ${deviceId}, systemType: ${systemType}):`,
      error,
    );
    return [];
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
  drainage: {
    source: alertService.ALERT_SOURCES.DRAINAGE,
    getSourceInfo: getDrainageInfo,
    getDeviceId: getDeviceIdFromDrainage,
  },
  power: {
    source: alertService.ALERT_SOURCES.POWER,
    getSourceInfo: getPowerInfo,
    getDeviceId: getDeviceIdFromPower,
  },
  fire: {
    source: alertService.ALERT_SOURCES.FIRE,
    getSourceInfo: getFireInfo,
    getDeviceId: getDeviceIdFromFire,
  },
  emergency_rescue: {
    source: alertService.ALERT_SOURCES.EMERGENCY_RESCUE,
    getSourceInfo: getEmergencyRescueInfo,
    getDeviceId: getDeviceIdFromEmergencyRescue,
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

    const isConnErr = isDeviceConnectionError(errorMessage);

    // 「停用=全停」：如果能映射到設備且設備非 active，直接跳過（不創建警示、不推送狀態）
    // - 避免停用設備仍持續產生 alerts/WS，造成前端仍收到「設備訊息」
    const mappedDeviceId = await config.getDeviceId(sourceId);
    if (mappedDeviceId) {
      const deviceInfoForGate = await getDeviceInfo(mappedDeviceId);
      if (
        deviceInfoForGate &&
        deviceInfoForGate.status &&
        deviceInfoForGate.status !== "active"
      ) {
        return false;
      }
    }

    // 判斷錯誤類型
    if (isConnErr) {
      // 設備連接錯誤 → 嘗試創建設備警報
      const deviceId = await config.getDeviceId(sourceId);
      if (deviceId) {
        // 獲取設備資訊
        const deviceInfo = await getDeviceInfo(deviceId);
        if (deviceInfo) {
          if (deviceInfo.status && deviceInfo.status !== "active") {
            return false;
          }
          // 創建設備警報
          const alertCreated = await errorTracker.recordError(
            alertService.ALERT_SOURCES.DEVICE,
            deviceId,
            "offline",
            errorMessage,
            {
              name: deviceInfo.name,
            },
          );

          // 推送 WebSocket 事件：設備離線（批次模式可跳過）
          if (!options.skipWebSocket) {
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
          `[systemAlertHelper] ⚠️  ${system} 來源 ID ${sourceId} 不存在，跳過錯誤記錄`,
        );
      }
      return false;
    }

    const alertType = isConnErr ? "offline" : "error";

    // 記錄錯誤並創建警報（如果達到閾值）
    const alertCreated = await errorTracker.recordError(
      config.source,
      sourceId,
      alertType,
      errorMessage,
      {
        name: sourceInfo.name,
        zone_name: sourceInfo.zone_name,
      },
    );

    // 推送 WebSocket 事件：系統設備離線（僅當創建了 offline 類型的警報時，批次模式可跳過）
    // 注意：設備狀態推送不應綁定「是否達到警報閾值」：
    // - 警報（alert）是「達閾後的 incident」
    // - 設備狀態（status）是「即時連線觀測」
    // 批次模式（skipWebSocket）會由 monitor 在輪次結束後統一用 batch emit 做狀態 diff 推送。
    if (alertType === "offline" && !options.skipWebSocket) {
      const deviceIdForWs = await config.getDeviceId(sourceId);
      websocketService.emitDeviceStatus(
        config.source,
        sourceId,
        "offline",
        deviceIdForWs,
      );
    }

    return alertCreated;
  } catch (error) {
    console.error(
      `[systemAlertHelper] 記錄 ${system} 錯誤失敗 (sourceId: ${sourceId}):`,
      error,
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

    const deviceId =
      system !== "device" ? await config.getDeviceId(sourceId) : null;

    if (deviceId) {
      const deviceCleared = await errorTracker.clearError(
        alertService.ALERT_SOURCES.DEVICE,
        deviceId,
        "offline",
      );
      if (deviceCleared && !options.skipWebSocket) {
        websocketService.emitDeviceStatus("device", deviceId, "online");
      }
    }

    const systemCleared = await errorTracker.clearError(
      config.source,
      sourceId,
    );

    if (
      (system === "environment" ||
        system === "lighting" ||
        system === "drainage" ||
        system === "power" ||
        system === "fire" ||
        system === "emergency_rescue") &&
      deviceId
    ) {
      const allSystemIds = await getLocationSystemIdsByDeviceId(
        deviceId,
        system,
      );
      for (const otherId of allSystemIds) {
        if (Number(otherId) === Number(sourceId)) continue;
        await errorTracker.clearError(config.source, otherId);
      }
    }

    if (systemCleared && !options.skipWebSocket) {
      websocketService.emitDeviceStatus(
        config.source,
        sourceId,
        "online",
        deviceId,
      );
    }
  } catch (error) {
    console.error(
      `[systemAlertHelper] 清除 ${system} 錯誤狀態失敗 (sourceId: ${sourceId}):`,
      error,
    );
  }
}

module.exports = {
  recordError,
  clearError,
  getDeviceIdFromConfig,
  // 導出輔助函數供內部使用
  getLocationInfo,
  getAreaInfo,
  getDeviceInfo,
  isDeviceConnectionError,
  // 導出系統配置供檢查
  SYSTEM_CONFIGS,
};
