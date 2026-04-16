/**
 * 統一系統警報輔助函數
 * 為所有系統提供統一的警報創建和管理接口
 * 取代多個系統專用的 helper 文件
 */

const alertService = require("./alertService");
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const logger = require("../../utils/logger");

const helperLogger = logger.createLogger("systemAlertHelper");

const getErrorTracker = () => require("./errorTracker");

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
    helperLogger.error("從配置提取設備 ID 失敗", {
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
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
    helperLogger.error("獲取來源資訊失敗", {
      systemType,
      systemId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
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
    helperLogger.error("獲取設備資訊失敗", {
      deviceId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
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
  "設備離線",
  "設備連接失敗",
  "服務不可用",
  "service unavailable",
];

function isDeviceConnectionError(errorMessage) {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return CONNECTION_ERROR_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * 從 location_systems.system_config 解析綁定的設備 ID（含 device_ids 陣列）
 * 與 environmentMonitor 展開 device_ids 的語意對齊，避免僅設 device_ids 時無法對應到 devices.id
 * @param {unknown} systemConfigRaw - JSON 或字串
 * @returns {number[]}
 */
function parseSystemConfigObject(systemConfigRaw) {
  return typeof systemConfigRaw === "string"
    ? JSON.parse(systemConfigRaw || "{}")
    : systemConfigRaw || {};
}

/** 僅 device_id／deviceId（不含 device_ids），供 recordError 對應 device 來源 */
function parseSingularDeviceIdFromSystemConfig(systemConfigRaw) {
  const c = parseSystemConfigObject(systemConfigRaw);
  const raw = c.device_id ?? c.deviceId;
  if (raw == null || raw === "") return null;
  const n = parseInt(String(raw), 10);
  return Number.isNaN(n) ? null : n;
}

/** device_id、deviceId、device_ids[] 去重；供 clearError 清除所有綁定設備之離線 */
function parseDeviceIdsFromSystemConfig(systemConfigRaw) {
  const config = parseSystemConfigObject(systemConfigRaw);
  const out = new Set();
  const push = (v) => {
    if (v == null || v === "") return;
    const n = parseInt(String(v), 10);
    if (!Number.isNaN(n)) out.add(n);
  };
  push(config.device_id ?? config.deviceId);
  for (const x of config.device_ids ?? []) {
    push(x);
  }
  return [...out];
}

async function fetchLocationSystemConfig(systemId, systemType) {
  const result = await db.query(
    `SELECT system_config FROM location_systems WHERE id = ? AND system_type = ?`,
    [systemId, systemType],
  );
  return result?.length ? result[0].system_config : null;
}

/**
 * 依系統類型從 location_systems 獲取所有綁定設備 ID
 * @param {number} systemId - location_systems.id
 * @param {string} systemType - 'environment' | 'lighting' | ...
 * @returns {Promise<number[]>}
 */
async function getDeviceIdsFromLocationSystem(systemId, systemType) {
  try {
    const raw = await fetchLocationSystemConfig(systemId, systemType);
    if (raw == null) return [];
    return parseDeviceIdsFromSystemConfig(raw);
  } catch (error) {
    helperLogger.error("取得設備 ID 列表失敗", {
      systemType,
      systemId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return [];
  }
}

/**
 * 依系統類型從 location_systems 獲取單一設備 ID（僅 device_id／deviceId；不含 device_ids）
 * @param {number} systemId - location_systems.id
 * @param {string} systemType - 'environment' | 'lighting'
 * @returns {Promise<number|null>}
 */
async function getDeviceIdFromLocationSystem(systemId, systemType) {
  try {
    const raw = await fetchLocationSystemConfig(systemId, systemType);
    if (raw == null) return null;
    return parseSingularDeviceIdFromSystemConfig(raw);
  } catch (error) {
    helperLogger.error("取得設備 ID 失敗", {
      systemType,
      systemId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
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
         AND (
           (
             system_config->>'device_id' IS NOT NULL
             AND (system_config->>'device_id')::integer = $2
           )
           OR (
             system_config->>'deviceId' IS NOT NULL
             AND (system_config->>'deviceId')::integer = $2
           )
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(
               COALESCE((system_config::jsonb->'device_ids'), '[]'::jsonb)
             ) AS device_elem(elem_text)
             WHERE (device_elem.elem_text)::integer = $2
           )
         )`,
      [systemType, deviceId],
    );
    return (result || []).map((r) => r.id);
  } catch (error) {
    helperLogger.error("依設備取得 location_systems 失敗", {
      deviceId,
      systemType,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
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
  const detail = await recordErrorDetailed(system, sourceId, errorMessage, options);
  return Boolean(detail?.alertCreated);
}

async function recordErrorDetailed(system, sourceId, errorMessage, options = {}) {
  try {
    const config = SYSTEM_CONFIGS[system];
    if (!config) {
      throw new Error(`未知的系統: ${system}`);
    }

    const isConnErr = isDeviceConnectionError(errorMessage);

    // 「停用=全停」：如果能映射到設備且設備非 active，直接跳過（不創建警示、不推送狀態）
    // - 避免停用設備仍持續產生 alerts/WS，造成前端仍收到「設備訊息」
    const mappedDeviceId = await config.getDeviceId(sourceId);
    let mappedDeviceInfo = null;
    if (mappedDeviceId) {
      mappedDeviceInfo = await getDeviceInfo(mappedDeviceId);
      if (mappedDeviceInfo?.status && mappedDeviceInfo.status !== "active") {
        return false;
      }
    }

    if (isConnErr && mappedDeviceId && mappedDeviceInfo) {
      const result = await getErrorTracker().recordErrorDetailed(
        alertService.ALERT_SOURCES.DEVICE,
        mappedDeviceId,
        "offline",
        errorMessage,
        {
          name: mappedDeviceInfo.name,
          origin: options?.origin
            ? { ...options.origin, systemKey: system, sourceId, deviceId: mappedDeviceId }
            : {
                channel: "system_alert_helper",
                systemKey: system,
                sourceId,
                deviceId: mappedDeviceId,
              },
        },
      );

      if (!options.skipWebSocket) {
        websocketService.emitDeviceStatus("device", mappedDeviceId, "offline");
      }

      return { ...result, mappedDeviceId };
    }

    // 系統業務錯誤或找不到設備 → 創建系統警報
    const sourceInfo = await config.getSourceInfo(sourceId);
    if (!sourceInfo) {
      helperLogger.debug("來源 ID 不存在，跳過錯誤記錄", {
        system,
        sourceId,
        module: "systemAlertHelper",
      });
      return false;
    }

    const alertType = isConnErr ? "offline" : "error";

    // 記錄錯誤並創建警報（如果達到閾值）
    const result = await getErrorTracker().recordErrorDetailed(
      config.source,
      sourceId,
      alertType,
      errorMessage,
      {
        name: sourceInfo.name,
        zone_name: sourceInfo.zone_name,
        origin: options?.origin
          ? { ...options.origin, systemKey: system, sourceId, deviceId: mappedDeviceId ?? null }
          : {
              channel: "system_alert_helper",
              systemKey: system,
              sourceId,
              deviceId: mappedDeviceId ?? null,
            },
      },
    );

    // 推送 WebSocket 事件：系統設備離線（僅當創建了 offline 類型的警報時，批次模式可跳過）
    // 注意：設備狀態推送不應綁定「是否達到警報閾值」：
    // - 警報（alert）是「達閾後的 incident」
    // - 設備狀態（status）是「即時連線觀測」
    // 批次模式（skipWebSocket）會由 monitor 在輪次結束後統一用 batch emit 做狀態 diff 推送。
    if (alertType === "offline" && !options.skipWebSocket) {
      websocketService.emitDeviceStatus(
        config.source,
        sourceId,
        "offline",
        mappedDeviceId,
      );
    }

    return { ...result, mappedDeviceId };
  } catch (error) {
    helperLogger.error("記錄錯誤失敗", {
      system,
      sourceId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return { ignored: false, trackingUpdated: false, alertCreated: false, error: error.message };
  }
}

/**
 * Modbus HTTP 成功後：依 host/port 對應設備並清除 device 離線（單一入口）
 * @param {Object} deviceConfig - { host, port, unitId? }
 * @param {Object} [options] - 傳入 clearError（如 skipWebSocket）
 */
async function notifyModbusHttpDeviceRecovered(deviceConfig, options = {}) {
  const deviceId = await getDeviceIdFromConfig(deviceConfig);
  if (!deviceId) return;
  await clearError("device", deviceId, options);
}

/**
 * Modbus HTTP 失敗後：依 host/port 對應設備並累計 device 離線（單一入口；冷卻由呼叫端處理）
 * @returns {Promise<boolean>} 是否觸發 recordError 流程
 */
async function notifyModbusHttpDeviceFailed(
  deviceConfig,
  errorMessage,
  options = {},
) {
  const deviceId = await getDeviceIdFromConfig(deviceConfig);
  if (!deviceId) return false;
  const detail = await recordErrorDetailed("device", deviceId, errorMessage, {
    ...options,
    origin: {
      channel: "modbus_http",
      deviceId,
      host: deviceConfig?.host,
      port: deviceConfig?.port,
      unitId: deviceConfig?.unitId,
    },
  });
  return Boolean(detail?.alertCreated);
}

/** 背景快照／監控用：以 SYSTEM_CONFIGS 推導（單一真相） */
const SNAPSHOT_CONNECTIVITY_SYSTEM_KEYS = new Set(
  Object.keys(SYSTEM_CONFIGS).filter((k) => k !== "device"),
);

/**
 * 背景監控或快照讀取後：統一寫入連線成功（clear）或失敗（record）
 * 預設 `skipWebSocket: true`，由監控輪次結尾批次推送。
 * @param {string} systemKey - environment | lighting | drainage | power | fire | emergency_rescue
 * @param {number} sourceId - location_systems.id（與既有 recordError/clearError 一致）
 * @param {boolean} readOk - Modbus／讀點是否成功
 * @param {string} [errorMessageWhenFail] - 失敗時訊息
 * @param {Object} [options] - 覆寫傳入 recordError／clearError（如 skipWebSocket）
 * @returns {Promise<{changed:boolean, action:"cleared"|"recorded", deviceClearedAny?:boolean, systemClearedAny?:boolean, alertCreated?:boolean, deviceIds?:number[]}>}
 */
async function syncLocationSnapshotReadResult(
  systemKey,
  sourceId,
  readOk,
  errorMessageWhenFail = "無法讀取設備資料",
  options = {},
) {
  if (!SNAPSHOT_CONNECTIVITY_SYSTEM_KEYS.has(systemKey)) {
    throw new Error(
      `[systemAlertHelper] syncLocationSnapshotReadResult 不支援: ${systemKey}`,
    );
  }
  const opts = { skipWebSocket: true, ...options };
  if (readOk) {
    const result = await clearErrorDetailed(systemKey, sourceId, opts);
    return {
      changed: Boolean(result.deviceClearedAny || result.systemClearedAny),
      action: "cleared",
      deviceClearedAny: result.deviceClearedAny,
      systemClearedAny: result.systemClearedAny,
      deviceIds: result.deviceIds,
    };
  }
  const detail = await recordErrorDetailed(systemKey, sourceId, errorMessageWhenFail, {
    ...opts,
    origin: {
      channel: "monitor_snapshot",
      systemKey,
      sourceId,
    },
  });
  return {
    // 失敗路徑：若達閾且 incident 建立/更新成功，視為「外部可見狀態」變更
    changed: Boolean(detail?.thresholdReached && detail?.alertCreated),
    action: "recorded",
    alertCreated: Boolean(detail?.alertCreated),
    thresholdReached: Boolean(detail?.thresholdReached),
    errorCount: typeof detail?.errorCount === "number" ? detail.errorCount : undefined,
    threshold: typeof detail?.threshold === "number" ? detail.threshold : undefined,
  };
}

/**
 * 清除系統錯誤狀態
 * @param {string} system - 系統名稱
 * @param {number} sourceId - 來源實體 ID
 * @param {Object} options - 選項
 * @param {boolean} options.skipWebSocket - 是否跳過 WebSocket 推送（用於批次模式）
 * @returns {Promise<void>}
 */
async function clearErrorDetailed(system, sourceId, options = {}) {
  try {
    const config = SYSTEM_CONFIGS[system];
    if (!config) {
      throw new Error(`未知的系統: ${system}`);
    }

    const deviceIds =
      system === "device"
        ? [sourceId]
        : await getDeviceIdsFromLocationSystem(sourceId, system);

    let deviceClearedAny = false;
    for (const deviceId of deviceIds) {
      const deviceCleared = await getErrorTracker().clearError(
        alertService.ALERT_SOURCES.DEVICE,
        deviceId,
        "offline",
      );
      deviceClearedAny = deviceClearedAny || Boolean(deviceCleared);
      if (deviceCleared && !options.skipWebSocket) {
        websocketService.emitDeviceStatus("device", deviceId, "online");
      }
    }

    const systemCleared = await getErrorTracker().clearError(
      config.source,
      sourceId,
    );

    if (system !== "device" && deviceIds.length > 0) {
      const clearedOtherSystemIds = new Set();
      for (const deviceId of deviceIds) {
        const allSystemIds = await getLocationSystemIdsByDeviceId(
          deviceId,
          system,
        );
        for (const otherId of allSystemIds) {
          if (Number(otherId) === Number(sourceId)) continue;
          const key = String(otherId);
          if (clearedOtherSystemIds.has(key)) continue;
          clearedOtherSystemIds.add(key);
          await getErrorTracker().clearError(config.source, otherId);
        }
      }
    }

    if (systemCleared && !options.skipWebSocket) {
      websocketService.emitDeviceStatus(
        config.source,
        sourceId,
        "online",
        deviceIds[0] ?? null,
      );
    }
    return {
      deviceIds,
      deviceClearedAny,
      systemClearedAny: Boolean(systemCleared),
    };
  } catch (error) {
    helperLogger.error("清除錯誤狀態失敗", {
      system,
      sourceId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return { deviceIds: [], deviceClearedAny: false, systemClearedAny: false };
  }
}

async function clearError(system, sourceId, options = {}) {
  await clearErrorDetailed(system, sourceId, options);
}

module.exports = {
  recordError,
  clearError,
  getDeviceIdFromConfig,
  notifyModbusHttpDeviceRecovered,
  notifyModbusHttpDeviceFailed,
  syncLocationSnapshotReadResult,
  // 導出輔助函數供內部使用
  getLocationInfo,
  getAreaInfo,
  getDeviceInfo,
  isDeviceConnectionError,
  // 導出系統配置供檢查
  SYSTEM_CONFIGS,
};
