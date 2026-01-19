const express = require("express");
const http = require("http");
const cors = require("cors");
const morgan = require("morgan");
const os = require("os");
const config = require("./config");

// 向後兼容：使用新的配置結構
const serverConfig = {
	serverHost: config.server.host,
	serverPort: config.server.port,
	...config,
};

// 中間件
const errorHandler = require("./middleware/errorHandler");
const responseHandler = require("./middleware/responseHandler");
const { securityHeaders } = require("./middleware/common");
const logger = require("./utils/logger");

// 路由
const modbusRoutes = require("./routes/modbusRoutes");
const userRoutes = require("./routes/userRoutes");
const rtspRoutes = require("./routes/rtspRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const lightingRoutes = require("./routes/lightingRoutes");
const environmentRoutes = require("./routes/environmentRoutes");
const locationRoutes = require("./routes/locationRoutes");
const peopleCountingRoutes = require("./routes/peopleCountingRoutes");
const alertRoutes = require("./routes/alertRoutes");
const externalDataRoutes = require("./routes/externalDataRoutes");

// 服務
const mediaMTXService = require("./services/communication/mediaMTXService");
const db = require("./database/db");
const externalDb = require("./database/externalDb");
const websocketService = require("./services/websocket/websocketService");

// 背景監控服務
const backgroundMonitor = require("./services/monitoring/backgroundMonitor");
const environmentMonitor = require("./services/monitoring/environmentMonitor");
const lightingMonitor = require("./services/monitoring/lightingMonitor");

// 警報自動清理服務
const alertCleanupService = require("./services/alerts/alertCleanupService");

// 設備資料記錄服務
const deviceDataLogger = require("./services/devices/deviceDataLogger");

// 監聽 MediaMTX 串流服務的錯誤事件，避免未處理的錯誤導致程序崩潰
// 注意：WebSocket 事件推送已整合到 mediaMTXService 中
const mediaMTXLogger = logger.createLogger("MediaMTX Service");

mediaMTXService.on("error", (errorInfo) => {
  // 只記錄簡潔的錯誤信息，不輸出完整堆疊跟踪
  const errorMsg = errorInfo.error?.message || "未知錯誤";
  mediaMTXLogger.error(`串流錯誤 (${errorInfo.streamId})`, { error: errorMsg });
  // 不拋出錯誤，只記錄，避免程序崩潰
});

mediaMTXService.on("end", (streamInfo) => {
  mediaMTXLogger.info(`串流正常結束`, { streamId: streamInfo.streamId });
});

const app = express();

const allowedOrigins = serverConfig.cors.origins;
const corsOptions = {
  origin: (origin, callback) => {
    // 允許無來源（如 Postman）以及白名單網域
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
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Cache-Control",
    "Pragma",
  ],
  exposedHeaders: ["Authorization"],
};

// CORS 設定
app.use(cors(corsOptions));

// 安全標頭
app.use(securityHeaders);

// 請求體解析（增加大小限制用於上傳圖片等大文件，例如 base64 編碼的圖片）
// 10MB 限制應該足夠應對大多數情況
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// HTTP 請求日誌（過濾掉 /ws 請求的日誌，避免日誌被刷屏）
app.use(
  morgan("dev", {
    skip: (req) => req.url === "/ws",
  })
);

// 統一響應格式中間件
app.use(responseHandler);

// 註冊路由
app.use("/api/modbus", modbusRoutes);
app.use("/api/users", userRoutes);
app.use("/api/rtsp", rtspRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/lighting", lightingRoutes);
app.use("/api/environment", environmentRoutes);
app.use("/api/locations", locationRoutes); // 統一地點管理 API
app.use("/api/people-counting", peopleCountingRoutes); // 人流統計地點管理 API
app.use("/api/alerts", alertRoutes);
app.use("/api/external-data", externalDataRoutes);

// 注意：HLS 串流現在由 MediaMTX 提供，不再需要本地靜態文件服務
// MediaMTX 在 http://localhost:8888 提供 HLS 服務

// 移除舊的 /ws 端點，現在使用 Socket.IO
// Socket.IO 會自動處理 WebSocket 連接

// 統一錯誤處理中間件（必須放在所有路由之後）
app.use(errorHandler);

// 獲取區域網路 IP 地址
function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳過內部（localhost）和非 IPv4 地址
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }

  return addresses.length > 0 ? addresses[0] : "localhost";
}

/**
 * 啟動伺服器
 */
async function startServer() {
  const serverLogger = logger.createLogger("Server");

  try {
  // 測試資料庫連線
  const dbConnected = await db.testConnection();
  if (!dbConnected) {
      serverLogger.warn("資料庫連線失敗，但伺服器仍會啟動");
    } else {
      serverLogger.info("資料庫連線成功");
  }

  // 測試外部資料庫連線
  const externalDbConnected = await externalDb.testConnection();
  if (!externalDbConnected) {
      serverLogger.warn("外部資料庫連線失敗，外部資料功能可能無法使用");
    } else {
      serverLogger.info("外部資料庫連線成功");
  }

  // 註冊並啟動背景監控任務（如果啟用）
  if (serverConfig.monitoring.enabled) {
    backgroundMonitor.registerMonitoringTask(
      "環境系統",
      environmentMonitor.checkEnvironmentLocations
    );
    backgroundMonitor.registerMonitoringTask(
      "照明系統",
      lightingMonitor.checkLightingAreas
    );

    // 啟動背景監控服務
    backgroundMonitor.startMonitoring();
      serverLogger.info("背景監控服務已啟用");
  } else {
      serverLogger.warn("背景監控服務已停用（設定 MONITORING_ENABLED=false）");
  }

  // 啟動警報自動清理服務
  alertCleanupService.startCleanupScheduler();
    serverLogger.info("警報自動清理服務已啟用");

  // 啟動設備資料記錄服務的定時刷新
  deviceDataLogger.start();
    serverLogger.info("設備資料記錄服務已啟用");

  const localIP = getLocalIPAddress();

  // 創建 HTTP 伺服器
  const httpServer = http.createServer(app);

  // 初始化 WebSocket 服務
  websocketService.initializeWebSocket(httpServer, corsOptions);

  // 啟動 HTTP 伺服器（Socket.IO 會自動附加到 HTTP 伺服器）
    httpServer.listen(serverConfig.serverPort, serverConfig.serverHost, () => {
      serverLogger.info(`BA 系統後端服務已啟動，監聽 ${config.serverHost}:${config.serverPort}`);
      serverLogger.info(`本機連線: http://localhost:${config.serverPort}`);
      serverLogger.info(`區域網路連線: http://${localIP}:${config.serverPort}`);
      serverLogger.info(`WebSocket 服務已啟用 (Socket.IO)`);
      
    if (localIP !== "localhost") {
      console.log(`\n💡 其他裝置可透過以下網址訪問:`);
      console.log(`   http://${localIP}:${config.serverPort}`);
    }
  });
  } catch (error) {
    serverLogger.error("啟動伺服器失敗", { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

/**
 * 優雅關閉伺服器
 */
const shutdownLogger = logger.createLogger("Shutdown");

async function gracefulShutdown(signal) {
  shutdownLogger.info(`收到 ${signal}，正在關閉伺服器...`);

  try {
    // 停止背景監控服務
  backgroundMonitor.stopMonitoring();
    shutdownLogger.info("背景監控服務已停止");

    // 停止設備資料記錄服務
    deviceDataLogger.stop();
    shutdownLogger.info("設備資料記錄服務已停止");

    // 停止所有 RTSP 串流（包括 FFmpeg 進程）
    await mediaMTXService.stopAllStreams();
    shutdownLogger.info("所有 RTSP 串流已停止");
    
    // 確保所有 FFmpeg 進程都已停止
    const ffmpegService = require("./services/communication/ffmpegService");
    await ffmpegService.stopAllProcesses();
    shutdownLogger.info("所有 FFmpeg 進程已停止");

    // 關閉資料庫連線
  await db.close();
  await externalDb.close();
    shutdownLogger.info("資料庫連線已關閉");

    shutdownLogger.info("伺服器已優雅關閉");
  process.exit(0);
  } catch (error) {
    shutdownLogger.error("關閉伺服器時發生錯誤", { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// 監聽終止信號
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// 處理未捕獲的異常
process.on("uncaughtException", (error) => {
  logger.error("未捕獲的異常", { error: error.message, stack: error.stack });
  gracefulShutdown("uncaughtException");
});

// 處理未處理的 Promise 拒絕
process.on("unhandledRejection", (reason, promise) => {
  logger.error("未處理的 Promise 拒絕", { reason, promise });
  // 不立即退出，記錄錯誤即可
});

startServer();
