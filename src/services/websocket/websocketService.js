/**
 * WebSocket 服務
 * 使用 Socket.IO 提供即時推送功能
 */

let ioInstance = null;

/**
 * 檢查 Socket.IO 實例是否可用
 * @returns {boolean}
 */
function isAvailable() {
  if (!ioInstance) {
    console.warn("[WebSocket] Socket.IO 實例尚未初始化，跳過事件推送");
    return false;
  }
  return true;
}

/**
 * 通用的 WebSocket 事件推送函數（帶錯誤處理和日誌）
 * 所有事件都會廣播給所有連接的客戶端
 * @param {string} eventName - 事件名稱
 * @param {*} data - 事件資料
 * @param {Object} options - 選項
 * @param {string} options.logMessage - 日誌訊息（可選）
 */
function safeEmit(eventName, data, options = {}) {
  if (!isAvailable()) {
    return;
  }

  const { logMessage } = options;

  // 廣播給所有連接的客戶端
  ioInstance.emit(eventName, data);

  // 僅在明確開啟時輸出推送日誌，避免刷屏（LOG_WS_PUSH=true）
  if (process.env.LOG_WS_PUSH === "true" && logMessage) {
    console.log(
      `[WebSocket] 推送事件: ${eventName}${logMessage ? ` - ${logMessage}` : ""}`
    );
  }
}

/**
 * 初始化 WebSocket 服務
 * @param {Object} httpServer - HTTP 伺服器實例
 * @param {Object} corsOptions - CORS 選項
 * @returns {Object} Socket.IO 實例
 */
function initializeWebSocket(httpServer, corsOptions) {
  const { Server } = require("socket.io");

  // 解析允許的來源（與 Express CORS 配置一致）
  const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  ioInstance = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        // 使用與 Express CORS 相同的邏輯
        if (
          !origin ||
          allowedOrigins.includes("*") ||
          allowedOrigins.includes(origin)
        ) {
          return callback(null, true);
        }
        return callback(new Error(`不被允許的跨域來源: ${origin}`), false);
      },
      credentials: true,
      methods: ["GET", "POST"],
    },
    // 連接超時設置
    connectTimeout: 45000,
    // Ping 超時設置
    pingTimeout: 20000,
    // Ping 間隔
    pingInterval: 25000,
  });

  // 連接事件處理（僅在 LOG_WS_CONNECTIONS=true 時輸出連線/斷線日誌）
  const logConnections = process.env.LOG_WS_CONNECTIONS === "true";
  ioInstance.on("connection", (socket) => {
    if (logConnections) console.log(`[WebSocket] 客戶端已連接: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      if (logConnections) console.log(`[WebSocket] 客戶端已斷開: ${socket.id}, 原因: ${reason}`);
    });

    // 客戶端錯誤處理
    socket.on("error", (error) => {
      console.error(`[WebSocket] 客戶端錯誤 (${socket.id}):`, error);
    });
  });

  console.log("✅ WebSocket 服務已初始化");
  return ioInstance;
}

/**
 * 獲取 Socket.IO 實例
 * @returns {Object|null} Socket.IO 實例
 */
function getIO() {
  return ioInstance;
}

/**
 * 推送新警報事件
 * @param {Object} alert - 警報資料
 */
function emitAlertNew(alert) {
  safeEmit("alert:new", alert, {
    logMessage: `警報 ID: ${alert.id}`,
  });
}

/**
 * 推送警報更新事件
 * @param {Object} alert - 更新後的警報資料
 * @param {string} oldStatus - 舊狀態
 * @param {string} newStatus - 新狀態
 */
function emitAlertUpdated(alert, oldStatus, newStatus) {
  safeEmit(
    "alert:updated",
    {
      alert,
      oldStatus,
      newStatus,
      timestamp: new Date().toISOString(),
    },
    {
      logMessage: `警報 ID: ${alert.id}, ${oldStatus} -> ${newStatus}`,
    }
  );
}

/**
 * 推送未解決警報數量變化事件
 * @param {number} count - 未解決警報數量
 */
function emitAlertCount(count) {
  safeEmit("alert:count", {
    count,
    timestamp: new Date().toISOString(),
  });
}

/**
 * 推送設備狀態變化事件
 * @param {string} system - 系統名稱 (environment, lighting, device)
 * @param {number} sourceId - 來源 ID (systemId 或 deviceId)
 * @param {string} status - 狀態 (online, offline)
 * @param {number} [deviceId] - 可選的設備 ID（用於前端設備管理頁面）
 */
function emitDeviceStatus(system, sourceId, status, deviceId = null) {
  safeEmit(
    "monitoring:device:status",
    {
      system,
      sourceId,
      deviceId: deviceId || sourceId, // 如果是 device 系統，deviceId = sourceId；否則使用提供的 deviceId
      status,
      timestamp: new Date().toISOString(),
    },
    {
      logMessage: `${system}, ${sourceId}, ${status}`,
    }
  );
}

/**
 * 批次推送設備狀態變化事件
 * @param {Array} updates - 狀態更新陣列
 * @param {Object} updates[].system - 系統名稱 (environment, lighting, device)
 * @param {number} updates[].sourceId - 來源 ID (systemId 或 deviceId)
 * @param {string} updates[].status - 狀態 (online, offline)
 * @param {number} [updates[].deviceId] - 可選的設備 ID（用於前端設備管理頁面）
 */
function emitBatchDeviceStatus(updates) {
  if (!updates || updates.length === 0) {
    return;
  }

  // 按系統和狀態分組，減少推送次數
  const grouped = updates.reduce((acc, update) => {
    const key = `${update.system}:${update.status}`;
    if (!acc[key]) {
      acc[key] = {
        system: update.system,
        status: update.status,
        updates: [],
      };
    }
    acc[key].updates.push({
      sourceId: update.sourceId,
      deviceId: update.deviceId || update.sourceId, // 如果是 device 系統，deviceId = sourceId；否則使用提供的 deviceId
    });
    return acc;
  }, {});

  // 為每個系統-狀態組合推送批次事件
  Object.values(grouped).forEach((group) => {
    safeEmit(
      "monitoring:device:status:batch",
      {
        system: group.system,
        status: group.status,
        updates: group.updates,
        timestamp: new Date().toISOString(),
      },
      {
        logMessage: `${group.system} (${group.status}): ${group.updates.length} 個設備`,
      }
    );
  });
}

/**
 * 推送監控任務執行摘要事件
 * @deprecated 前端不需要此事件，已停用。如需監控任務狀態，請使用 REST API 或管理員專用監控面板
 * @param {Object} summary - 監控摘要數據
 * @param {string} summary.timestamp - 時間戳
 * @param {Array} summary.tasks - 任務列表
 * @param {number} summary.totalDuration - 總執行時間（毫秒）
 */
function emitMonitoringStatus(summary) {
  // 前端不需要 monitoring:status 事件，已停用推送
  // 保留函數以維持 API 兼容性（未來管理員監控面板可能需要）
  if (process.env.NODE_ENV === "development") {
    console.log(
      `[WebSocket] monitoring:status 已停用（前端不需要此事件）`
    );
  }
  // safeEmit("monitoring:status", summary, {
  //   logMessage: `${summary.tasks?.length || 0} 個任務`,
  // });
}

/**
 * 推送設備創建事件
 * @param {Object} data - 事件資料
 * @param {Object} data.device - 設備資料
 * @param {number} data.userId - 創建用戶 ID
 */
function emitDeviceCreated(data) {
  safeEmit(
    "device:created",
    {
      device: data.device,
      userId: data.userId,
      timestamp: new Date().toISOString(),
    },
    {
      logMessage: `設備 ID: ${data.device?.id}`,
    }
  );
}

/**
 * 推送設備更新事件
 * @param {Object} data - 事件資料
 * @param {Object} data.device - 更新後的設備資料
 * @param {Object} data.changes - 變更的欄位（可選）
 * @param {number} data.userId - 更新用戶 ID
 */
function emitDeviceUpdated(data) {
  safeEmit(
    "device:updated",
    {
      device: data.device,
      changes: data.changes || {},
      userId: data.userId,
      timestamp: new Date().toISOString(),
    },
    {
      logMessage: `設備 ID: ${data.device?.id}`,
    }
  );
}

/**
 * 推送設備刪除事件
 * @param {Object} data - 事件資料
 * @param {number} data.deviceId - 設備 ID
 * @param {number} data.userId - 刪除用戶 ID（可選）
 */
function emitDeviceDeleted(data) {
  safeEmit(
    "device:deleted",
    {
      deviceId: data.deviceId,
      userId: data.userId,
      timestamp: new Date().toISOString(),
    },
    {
      logMessage: `設備 ID: ${data.deviceId}`,
    }
  );
}

/**
 * 推送設備狀態變更事件
 * @param {Object} data - 事件資料
 * @param {number} data.deviceId - 設備 ID
 * @param {string} data.oldStatus - 舊狀態
 * @param {string} data.newStatus - 新狀態
 * @param {number} data.userId - 變更用戶 ID（可選）
 */
function emitDeviceStatusChanged(data) {
  safeEmit(
    "device:status:changed",
    {
      deviceId: data.deviceId,
      oldStatus: data.oldStatus,
      newStatus: data.newStatus,
      userId: data.userId,
      timestamp: new Date().toISOString(),
    },
    {
      logMessage: `設備 ID: ${data.deviceId}, ${data.oldStatus} -> ${data.newStatus}`,
    }
  );
}

/**
 * 推送環境感測器讀數事件
 * @param {Object} data - 事件資料
 * @param {number} data.locationId - 位置 ID
 * @param {Object} data.reading - 讀數資料
 */
function emitEnvironmentReading(data) {
  const eventData = {
    locationId: data.locationId,
    reading: data.reading,
    timestamp: new Date().toISOString(),
  };

  // 廣播給所有連接的客戶端
  safeEmit("environment:reading:new", eventData, {
    logMessage: `位置 ID: ${data.locationId}`,
  });
}

/**
 * 推送人流統計新記錄事件
 * @param {Object} data - 事件資料
 * @param {string} data.id - 記錄 ID
 * @param {number} data.personId - 人員 ID
 * @param {string} data.personName - 人員名稱
 * @param {number|null} data.unitId - 單位 ID
 * @param {string} data.unitName - 單位名稱
 * @param {string} data.eventType - 事件類型 (entry/exit/failed)
 * @param {string} data.timestamp - 時間戳
 * @param {string} data.deviceScreenshotUrl - 設備截圖 URL
 * @param {number|null} data.physicalId - 設備 ID
 * @param {number|null} data.locationId - 地點 ID
 * @param {string|null} data.locationName - 地點名稱
 */
function emitPeopleCountingRecord(data) {
  safeEmit(
    "people_counting:record:new",
    {
      ...data,
      // 保留原始時間戳（記錄的實際刷卡時間）
      timestamp: data.timestamp || new Date().toISOString(),
    },
    {
      logMessage: `人員 ID: ${data.personId}, 事件: ${data.eventType}`,
    }
  );
}

/** 門禁事件寫入後推送，前端人流統計頁監聽 people-counting:access-control:event 並重新載入 */
function emitIsapiAccessEvent() {
  safeEmit("people-counting:access-control:event", { source: "isapi", timestamp: new Date().toISOString() }, { logMessage: "門禁事件已寫入" });
}

/** 攝影機 PeopleCounting 事件寫入後推送，前端人流統計頁監聽 people-counting:camera:event 並重新載入 */
function emitIsapiPeopleCountingCameraEvent(payload = {}) {
  safeEmit(
    "people-counting:camera:event",
    { source: "isapi_camera", timestamp: new Date().toISOString(), ...payload },
    { logMessage: "攝影機人流事件已寫入" },
  );
}

module.exports = {
  initializeWebSocket,
  getIO,
  emitAlertNew,
  emitAlertUpdated,
  emitAlertCount,
  emitDeviceStatus,
  emitBatchDeviceStatus,
  emitMonitoringStatus,
  emitDeviceCreated,
  emitDeviceUpdated,
  emitDeviceDeleted,
  emitDeviceStatusChanged,
  emitEnvironmentReading,
  emitPeopleCountingRecord,
  emitIsapiAccessEvent,
  emitIsapiPeopleCountingCameraEvent,
};
