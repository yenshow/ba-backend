/**
 * WebSocket 服務
 * 使用 Socket.IO 提供即時推送功能
 */

let ioInstance = null;

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

  // 連接事件處理
  ioInstance.on("connection", (socket) => {
    console.log(`[WebSocket] 客戶端已連接: ${socket.id}`);

    // 客戶端斷開連接
    socket.on("disconnect", (reason) => {
      console.log(`[WebSocket] 客戶端已斷開連接: ${socket.id}, 原因: ${reason}`);
    });

    // 客戶端錯誤處理
    socket.on("error", (error) => {
      console.error(`[WebSocket] 客戶端錯誤 (${socket.id}):`, error);
    });

    // 客戶端加入警報房間（可選，用於更細粒度的控制）
    socket.on("join:alerts", () => {
      socket.join("alerts");
      console.log(`[WebSocket] 客戶端 ${socket.id} 加入警報房間`);
    });

    // 客戶端離開警報房間
    socket.on("leave:alerts", () => {
      socket.leave("alerts");
      console.log(`[WebSocket] 客戶端 ${socket.id} 離開警報房間`);
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
  if (!ioInstance) {
    console.warn("[WebSocket] Socket.IO 實例尚未初始化，跳過事件推送");
    return;
  }

  ioInstance.emit("alert:new", alert);
  if (process.env.NODE_ENV === "development") {
    console.log(`[WebSocket] 推送事件: alert:new (警報 ID: ${alert.id})`);
  }
}

/**
 * 推送警報更新事件
 * @param {Object} alert - 更新後的警報資料
 * @param {string} oldStatus - 舊狀態
 * @param {string} newStatus - 新狀態
 */
function emitAlertUpdated(alert, oldStatus, newStatus) {
  if (!ioInstance) {
    console.warn("[WebSocket] Socket.IO 實例尚未初始化，跳過事件推送");
    return;
  }

  ioInstance.emit("alert:updated", {
    alert,
    oldStatus,
    newStatus,
    timestamp: new Date().toISOString(),
  });
  if (process.env.NODE_ENV === "development") {
    console.log(
      `[WebSocket] 推送事件: alert:updated (警報 ID: ${alert.id}, ${oldStatus} -> ${newStatus})`
    );
  }
}

/**
 * 推送未解決警報數量變化事件
 * @param {number} count - 未解決警報數量
 */
function emitAlertCount(count) {
  if (!ioInstance) {
    console.warn("[WebSocket] Socket.IO 實例尚未初始化，跳過事件推送");
    return;
  }

  ioInstance.emit("alert:count", {
    count,
    timestamp: new Date().toISOString(),
  });
}

/**
 * 推送設備狀態變化事件
 * @param {string} system - 系統名稱 (environment, lighting, device)
 * @param {number} sourceId - 來源 ID
 * @param {string} status - 狀態 (online, offline)
 */
function emitDeviceStatus(system, sourceId, status) {
  if (!ioInstance) {
    console.warn("[WebSocket] Socket.IO 實例尚未初始化，跳過事件推送");
    return;
  }

  ioInstance.emit("monitoring:device:status", {
    system,
    sourceId,
    status,
    timestamp: new Date().toISOString(),
  });
  if (process.env.NODE_ENV === "development") {
    console.log(
      `[WebSocket] 推送事件: monitoring:device:status (${system}, ${sourceId}, ${status})`
    );
  }
}

/**
 * 推送監控任務執行摘要事件
 * @param {Object} summary - 監控摘要數據
 * @param {string} summary.timestamp - 時間戳
 * @param {Array} summary.tasks - 任務列表
 * @param {number} summary.totalDuration - 總執行時間（毫秒）
 */
function emitMonitoringStatus(summary) {
  if (!ioInstance) {
    console.warn("[WebSocket] Socket.IO 實例尚未初始化，跳過事件推送");
    return;
  }

  ioInstance.emit("monitoring:status", summary);
  if (process.env.NODE_ENV === "development") {
    console.log(
      `[WebSocket] 推送事件: monitoring:status (${summary.tasks?.length || 0} 個任務)`
    );
  }
}

module.exports = {
  initializeWebSocket,
  getIO,
  emitAlertNew,
  emitAlertUpdated,
  emitAlertCount,
  emitDeviceStatus,
  emitMonitoringStatus,
};

