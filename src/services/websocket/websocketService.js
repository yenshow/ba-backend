/**
 * WebSocket 服務
 * 使用 Socket.IO 提供即時推送功能
 */

const config = require("../../config");
const logger = require("../../utils/logger");
const userService = require("../platform/userService");
const permissionService = require("../platform/permissionService");

let ioInstance = null;
const wsLogger = logger.createLogger("WebSocket");

const ROOM_LEGACY = "app:legacy";
const APP_ROOMS = new Set(["central", "construction"]);
const ROOMS_ALL_APPS = ["app:central", "app:construction"];
const PERM_ROOM_PREFIX = "perm:";

/**
 * 檢查 Socket.IO 實例是否可用
 * @returns {boolean}
 */
function isAvailable() {
  if (!ioInstance) {
    // 避免在啟動初期刷屏，僅用 warn，並保持結構化欄位
    wsLogger.warn("Socket.IO 實例尚未初始化，跳過事件推送", {
      event: "ws:emit:skip",
    });
    return false;
  }
  return true;
}

/**
 * 通用的 WebSocket 事件推送函數（帶錯誤處理和日誌）
 * 預設全廣播；若指定 rooms 則推送到指定 rooms（並保留 legacy room 做向下相容）
 * @param {string} eventName - 事件名稱
 * @param {*} data - 事件資料
 * @param {Object} options - 選項
 * @param {string} options.logMessage - 日誌訊息（可選）
 * @param {string[]} options.rooms - 推送的 rooms（可選）
 * @param {boolean} options.forceBroadcast - 強制全廣播 io.emit（可選；預設 false）
 */
function safeEmit(eventName, data, options = {}) {
  if (!isAvailable()) {
    return;
  }

  const { logMessage, rooms, forceBroadcast } = options;

  // 預設 rooms 策略（向下相容）：
  // - 未指定 rooms：推送到「所有 app rooms」+ legacy
  // - 指定 rooms：推送到「指定 rooms」+ legacy
  // - forceBroadcast=true：強制全廣播（少數情境才用）
  if (forceBroadcast === true) {
    ioInstance.emit(eventName, data);
  } else {
    const targetRooms =
      Array.isArray(rooms) && rooms.length > 0 ? rooms : ROOMS_ALL_APPS;

    const uniqueRooms = Array.from(
      new Set([...targetRooms, ROOM_LEGACY]),
    ).filter(Boolean);
    for (const room of uniqueRooms) {
      ioInstance.to(room).emit(eventName, data);
    }
  }

  if (logMessage) {
    wsLogger.debug("推送事件", {
      event: eventName,
      message: logMessage,
      rooms: Array.isArray(rooms) ? rooms : undefined,
    });
  }
}

/**
 * 初始化 WebSocket 服務
 * @param {Object} httpServer - HTTP 伺服器實例
 * @returns {Object} Socket.IO 實例
 */
function initializeWebSocket(httpServer) {
  const { Server } = require("socket.io");

  // 解析允許的來源（與 Express CORS 配置一致）
  const allowedOrigins = config.cors.origins.length
    ? config.cors.origins
    : ["http://localhost:3000"];

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

  const logConnections = true;
  ioInstance.on("connection", (socket) => {
    // 預設加入 legacy room，直到前端發送 client:hello 進行識別
    socket.join(ROOM_LEGACY);

    // 依 permissions 自動加入 rooms（不依賴 license；由後端驗證 token）
    // - token 來源：socket.io-client 的 auth.token
    // - 若無 token 或無效：維持 app:legacy/app:* 的基本分流即可
    (async () => {
      try {
        const token = String(socket.handshake?.auth?.token || "").trim();
        if (!token) return;

        const decoded = userService.verifyToken(token);
        if (!decoded?.id) return;

        const role = decoded.role || null;
        const result = await permissionService.getEffectivePermissionsForUser(
          decoded.id,
          role,
        );
        const codes = Array.isArray(result?.codes) ? result.codes : [];

        socket.data.userId = decoded.id;
        socket.data.role = decoded.role;
        socket.data.permissions = codes;

        for (const code of codes) {
          if (!code) continue;
          socket.join(`${PERM_ROOM_PREFIX}${code}`);
        }

        if (logConnections) {
          wsLogger.info("客戶端已加入 permission rooms", {
            socketId: socket.id,
            event: "ws:perm:join",
            userId: decoded.id,
            role: decoded.role,
            permissionCount: codes.length,
          });
        }
      } catch (error) {
        wsLogger.warn("permission rooms join 失敗", {
          socketId: socket.id,
          event: "ws:perm:join:error",
          error: error?.message || String(error),
        });
      }
    })();

    if (logConnections) {
      wsLogger.info("客戶端已連接", {
        socketId: socket.id,
        event: "ws:connect",
      });
    }

    // App 識別（向下相容：未發送仍留在 legacy）
    socket.on("client:hello", (payload = {}) => {
      try {
        const app = String(payload?.app || "").trim();
        if (!APP_ROOMS.has(app)) {
          wsLogger.warn("client:hello app 不合法，忽略", {
            socketId: socket.id,
            event: "ws:client:hello:invalid",
            app,
          });
          return;
        }

        socket.leave(ROOM_LEGACY);
        socket.join(`app:${app}`);

        if (logConnections) {
          wsLogger.info("客戶端已識別 app", {
            socketId: socket.id,
            event: "ws:client:hello",
            app,
            room: `app:${app}`,
          });
        }
      } catch (error) {
        wsLogger.warn("處理 client:hello 失敗", {
          socketId: socket.id,
          event: "ws:client:hello:error",
          error: error?.message || String(error),
        });
      }
    });

    socket.on("disconnect", (reason) => {
      if (logConnections) {
        wsLogger.info("客戶端已斷開", {
          socketId: socket.id,
          event: "ws:disconnect",
          reason,
        });
      }
    });

    // 客戶端錯誤處理
    socket.on("error", (error) => {
      wsLogger.warn("客戶端錯誤", {
        socketId: socket.id,
        event: "ws:client:error",
        error: error?.message || error,
      });
    });
  });

  wsLogger.info("WebSocket 服務已初始化", { event: "ws:init" });
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
    },
  );
}

/**
 * 推送未解決警報數量變化事件
 * @param {number} count - 未解決警報數量
 */
function emitAlertCount(count) {
  safeEmit("alert:count", { count, timestamp: new Date().toISOString() }, {});
}

/**
 * 每日日界線批次結案後廣播（避免逐筆 alert:updated 風暴）
 * @param {{ resolvedCount: number, occurredAt: string, timezone: string }} data
 */
function emitAlertDailyRollover(data) {
  safeEmit(
    "alert:daily_rollover",
    {
      resolvedCount: data.resolvedCount,
      occurredAt: data.occurredAt,
      timezone: data.timezone,
      timestamp: new Date().toISOString(),
    },
    {
      logMessage: `日界線結案 ${data.resolvedCount} 筆`,
    },
  );
}

/**
 * 推送設備狀態變化事件
 * @param {string} system - 系統名稱 (environment, lighting, device)
 * @param {number} sourceId - 來源 ID (systemId 或 deviceId)
 * @param {string} status - 狀態 (online, offline)
 * @param {number} [deviceId] - 可選的設備 ID（用於前端設備管理頁面）
 */
const DEVICE_STATUS_DEDUPE_TTL_MS = 2000;
const deviceStatusDedupe = new Map(); // key -> lastTs
let lastDedupeSweepAt = 0;

function sweepDeviceStatusDedupe(now) {
  // 只有在 map 變大或距離上次清理較久才掃描，避免每次 emit 都 O(n)
  const shouldSweep =
    deviceStatusDedupe.size > 2000 || now - lastDedupeSweepAt > 30_000;
  if (!shouldSweep) return;

  for (const [k, ts] of deviceStatusDedupe.entries()) {
    if (now - ts > DEVICE_STATUS_DEDUPE_TTL_MS) {
      deviceStatusDedupe.delete(k);
    }
  }
  lastDedupeSweepAt = now;
}

function emitDeviceStatus(system, sourceId, status, deviceId = null) {
  const now = Date.now();
  const dedupeKey = `${system}:${String(sourceId)}:${String(status)}`;
  const lastTs = deviceStatusDedupe.get(dedupeKey);
  if (lastTs && now - lastTs < DEVICE_STATUS_DEDUPE_TTL_MS) {
    return;
  }
  deviceStatusDedupe.set(dedupeKey, now);
  sweepDeviceStatusDedupe(now);

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
    },
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
      },
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
    },
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
    },
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
    },
  );
}

/**
 * 推送環境感測器讀數事件（方案 B 統一契約）
 * @param {Object} data
 * @param {number} data.locationId - 位置 ID
 * @param {string} data.recordedAt - 讀數時間（ISO）
 * @param {Object} data.data - 感測值（含 derived）
 * @param {Array<{deviceId:number,status:'online'|'offline'}>} data.devices - 本次相關設備連線狀態
 */
function emitEnvironmentReading(data) {
  const recordedAt = data.recordedAt || new Date().toISOString();
  const payloadData =
    data.data && typeof data.data === "object" ? data.data : {};

  const devices = Array.isArray(data.devices)
    ? data.devices
        .map((d) => ({
          deviceId: Number(d.deviceId ?? d.device_id),
          status: String(d.status || "").toLowerCase() === "online" ? "online" : "offline",
        }))
        .filter((d) => Number.isFinite(d.deviceId))
    : [];

  const eventData = {
    locationId: data.locationId,
    recordedAt,
    data: payloadData,
    devices,
    timestamp: new Date().toISOString(),
  };

  safeEmit("environment:reading:new", eventData, {
    logMessage: `位置 ID: ${data.locationId}`,
  });
}

/** 門禁事件寫入後推送，前端人流統計頁監聽 people-counting:access-control:event 並重新載入 */
function emitIsapiAccessEvent() {
  safeEmit(
    "people-counting:access-control:event",
    { source: "isapi", timestamp: new Date().toISOString() },
    { logMessage: "門禁事件已寫入" },
  );
}

/** 攝影機 PeopleCounting 事件寫入後推送，前端人流統計頁監聽並重新載入 */
function emitIsapiPeopleCountingEvent(data) {
  safeEmit(
    "people-counting:isapi-camera:event",
    {
      ...(data || {}),
      source: "isapi_camera",
      timestamp: new Date().toISOString(),
    },
    { logMessage: "攝影機人流事件已寫入" },
  );
}

/** 車輛 ISAPI ANPR 事件寫入後推送 */
function emitVehicleAccessIsapiEvent(data) {
  safeEmit(
    "vehicle-access:isapi-camera:event",
    {
      ...(data || {}),
      source: "isapi_camera",
      timestamp: new Date().toISOString(),
    },
    { logMessage: "車輛 ANPR 事件已寫入" },
  );
}

function emitYscpEvent(type) {
  const eventMap = {
    vehicle_access: "yscp:event:vehicle",
    acs: "yscp:event:acs",
  };
  const eventName = eventMap[type];
  if (!eventName) {
    wsLogger.warn("未知的 YSCP 事件類型，略過推送", {
      event: "ws:yscp:event:unknown",
      type,
    });
    return;
  }

  safeEmit(
    eventName,
    {
      type,
      timestamp: new Date().toISOString(),
    },
    {
      logMessage: `YSCP 事件: ${type}`,
    },
  );
}

module.exports = {
  initializeWebSocket,
  getIO,
  emitAlertNew,
  emitAlertUpdated,
  emitAlertCount,
  emitAlertDailyRollover,
  emitDeviceStatus,
  emitBatchDeviceStatus,
  emitMonitoringStatus,
  emitDeviceCreated,
  emitDeviceUpdated,
  emitDeviceDeleted,
  emitEnvironmentReading,
  emitIsapiAccessEvent,
  emitIsapiPeopleCountingEvent,
  emitVehicleAccessIsapiEvent,
  emitYscpEvent,
};
