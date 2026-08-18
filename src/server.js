const express = require("express");
const http = require("http");
const cors = require("cors");
const morgan = require("morgan");
const os = require("os");
const config = require("./config");
const { ensureRuntimeDataLayout } = require("./utils/baDataPaths");

ensureRuntimeDataLayout();

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
const { apiRateLimiter } = require("./middleware/rateLimitMiddleware");
const logger = require("./utils/logger");
const C = require("./utils/apiErrorCodes");

// 路由
const modbusRoutes = require("./routes/modbusRoutes");
const userRoutes = require("./routes/userRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const { mountSnapshotSystemRoutes } = require("./routes/snapshotSystems");
const environmentRoutes = require("./routes/environmentRoutes");
const energyRoutes = require("./routes/energyRoutes");
const locationRoutes = require("./routes/locationRoutes");
const peopleCountingRoutes = require("./routes/peopleCountingRoutes");
const elevatorRoutes = require("./routes/elevatorRoutes");
const accessSecurityRoutes = require("./routes/accessSecurityRoutes");
const vehicleAccessRoutes = require("./routes/vehicleAccessRoutes");
const alertRoutes = require("./routes/alertRoutes");
const operationalEventRoutes = require("./routes/operationalEventRoutes");
const externalDataRoutes = require("./routes/externalDataRoutes");
const accessControlRoutes = require("./routes/accessControlRoutes");
const ladderSdkRoutes = require("./routes/ladderSdkRoutes");
const personnelRoutes = require("./routes/personnelRoutes");
const yscpEventRoutes = require("./routes/yscpEventRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const runtimeConfigRoutes = require("./routes/runtimeConfigRoutes");
const externalSyncRoutes = require("./routes/externalSyncRoutes");
const recordExportRoutes = require("./routes/recordExportRoutes");
const entryExitRoutes = require("./routes/entryExitRoutes");
const monitoringRoutes = require("./routes/monitoringRoutes");
const { bootstrapRuntimeInfrastructure } = require("./services/platform/runtimeConfigApply");
const multimediaDashboardRoutes = require("./routes/multimediaDashboardRoutes");
const licenseRoutes = require("./routes/licenseRoutes");
const moduleRegistryRoutes = require("./routes/moduleRegistryRoutes");
const uploadRoutes = require("./routes/uploadRoutes");

// 授權（Feature Gate）
const { requireFeature } = require("./middleware/licenseMiddleware");

// 服務
const db = require("./database/db");
const yscpRuntimeService = require("./services/yscp/yscpRuntimeService");
const websocketService = require("./services/websocket/websocketService");
const syncDefinitions = require("./access/syncDefinitions");
const { applySchemaPatches } = require("./database/schemaPatches");

// 背景監控與 License Runtime
const licenseRuntimeService = require("./services/license/licenseRuntimeService");

// 備份排程
const backupScheduler = require("./services/backup/backupScheduler");
const externalIntegrationSchedulers = require("./services/externalIntegration/externalIntegrationSchedulers");
const {
  startAlertDailyRolloverScheduler,
} = require("./services/alerts/alertRolloverScheduler");

const app = express();

// 正式環境固定 trust proxy 1 hop（反向代理後限流 req.ip 正確）
if (config.isProduction) {
  app.set("trust proxy", 1);
}

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

// 統一響應格式（須早於限流，供 rateLimitHandler 等使用 sendFailure）
app.use(responseHandler);

// 極簡健康檢查（公開；不經 API 限流）
app.get("/api/health", async (req, res) => {
  try {
    const { pool } = require("./database/db");
    await pool.query("SELECT 1");
    return res.sendSuccess({ status: "ok", db: "ok" });
  } catch (err) {
    return res.sendError(
      "SERVICE_UNAVAILABLE",
      "database unavailable",
      503,
      { db: "error" },
    );
  }
});

// API 限流（登入路由在 userRoutes 內另掛更嚴格 limiter）
app.use("/api", apiRateLimiter);

// 請求體解析（10MB 限制）
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// HTTP 請求日誌：只記錄錯誤（>=400），避免 dev / prod 都刷屏
app.use(
  morgan("dev", {
    skip: (req, res) => {
      // 1) /ws（舊端點）或 Socket.IO polling（若存在）不記錄
      if (req.url === "/ws" || req.url?.startsWith("/socket.io")) {
        return true;
      }
      // health 探活不記錄
      if (req.url === "/api/health" || req.url?.startsWith("/api/health?")) {
        return true;
      }

      // 2) 僅記錄錯誤請求（>=400）
      return res.statusCode < 400;
    },
  }),
);

// 受保護上傳讀取（需登入；img 可用 ?access_token=）
app.use("/api/uploads", uploadRoutes);

// 註冊路由：業務模組寫入以 requirePermission + requireFeature；平台管理以 requireAdmin
app.use("/api/modbus", modbusRoutes);
app.use("/api/users", userRoutes);
app.use("/api/license", licenseRoutes);
app.use("/api/modules", moduleRegistryRoutes);
app.use("/api/devices", deviceRoutes);
mountSnapshotSystemRoutes(app, requireFeature);
app.use("/api/environment", requireFeature("environment"), environmentRoutes);
app.use("/api/energy", requireFeature("energy"), energyRoutes);
app.use("/api/locations", locationRoutes); // 統一地點管理 API
app.use(
  "/api/people-counting",
  requireFeature("people_counting"),
  peopleCountingRoutes,
); // 人流統計
app.use(
  "/api/elevator",
  requireFeature("elevator"),
  elevatorRoutes,
); // 電梯系統
app.use(
  "/api/access-security",
  requireFeature("access_security"),
  accessSecurityRoutes,
); // 門禁保全（VIS）
app.use(
  "/api/vehicle-access",
  requireFeature("vehicle_access"),
  vehicleAccessRoutes,
);
app.use("/api/alerts", alertRoutes);
app.use("/api/operational-events", operationalEventRoutes);
app.use("/api/external-data", externalDataRoutes); // 車輛相關路由在 externalDataRoutes 內依 requireFeature(vehicle_access) 控管
app.use("/api/access-control", accessControlRoutes);
app.use("/api/ladder-sdk", ladderSdkRoutes);
app.use("/api/personnel", personnelRoutes); // 人員主檔、門禁權限（僅角色控制）
app.use("/api/yscp", yscpEventRoutes);
app.use("/api/settings", settingsRoutes); // 系統設定 API
app.use("/api/runtime-config", runtimeConfigRoutes);
app.use("/api/external-sync", externalSyncRoutes);
app.use("/api/record-export", recordExportRoutes);
app.use("/api/entry-exit", entryExitRoutes);
app.use("/api/monitoring", monitoringRoutes);
app.use(
  "/api/multimedia",
  requireFeature("multimedia"),
  multimediaDashboardRoutes,
); // 多媒體資訊牆 API

// 影像監控：前端依 POST /api/devices/:id/stream/start 取得 webrtcUrl，以 WebRTC 播放

// 移除舊的 /ws 端點，現在使用 Socket.IO
// Socket.IO 會自動處理 WebSocket 連接

// 未匹配的 API 路徑
app.use((req, res) => {
  if (!req.path.startsWith("/api")) {
    res.status(404).end();
    return;
  }
  res.sendFailure(
    {
      code: C.NOT_FOUND,
      message: "找不到 API 路徑",
      details: { method: req.method, path: req.originalUrl },
    },
    404,
  );
});

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
    const localIP = getLocalIPAddress();

    // 開機時 SCM 可能並行起 PostgreSQL／Backend：先等 DB，再 listen，避免「Running 但半殘」
    const dbReady = await db.waitForDatabase({
      timeoutMs: 90_000,
      intervalMs: 2_000,
      logger: serverLogger,
    });
    if (!dbReady) {
      serverLogger.error(
        "資料庫未就緒（逾時）。請確認 {Product}-PostgreSQL／ACL 後由 WinSW 重試啟動。",
      );
      try {
        await db.close();
      } catch (_e) {}
      process.exit(1);
      return;
    }

    await applySchemaPatches(db.pool).catch((err) =>
      serverLogger.warn("schema patches 失敗", { error: err.message }),
    );
    await syncDefinitions(db.pool).catch((err) =>
      serverLogger.warn("權限定義同步失敗", { error: err.message }),
    );
    await bootstrapRuntimeInfrastructure();
    await licenseRuntimeService.reconcileBackgroundServices({ reason: "boot" });

    const httpServer = http.createServer(app);
    websocketService.initializeWebSocket(httpServer);

    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(
        serverConfig.serverPort,
        serverConfig.serverHost,
        resolve,
      );
    });

    const lanUrl =
      localIP !== "localhost"
        ? `http://${localIP}:${config.serverPort}`
        : undefined;
    serverLogger.info("BA 系統後端服務已啟動", {
      listen: `${config.serverHost}:${config.serverPort}`,
      localUrl: `http://localhost:${config.serverPort}`,
      ...(lanUrl ? { lanUrl } : {}),
      websocket: "Socket.IO",
    });

    global.__backupSchedulerHandle = backupScheduler.startScheduler();

    global.__alertRolloverStop = startAlertDailyRolloverScheduler();
    serverLogger.info("警報日界線排程已啟用（依 runtime 營運設定）");

    global.__externalSyncHandle = externalIntegrationSchedulers.startExternalSync();
    global.__recordExportHandle = externalIntegrationSchedulers.startRecordExport();

    global.__httpServer = httpServer;
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      serverLogger.error(
        `啟動失敗：${serverConfig.serverHost}:${serverConfig.serverPort} 已被佔用（EADDRINUSE）`,
      );
    } else {
      serverLogger.error("啟動伺服器失敗", {
        error: error.message,
        stack: error.stack,
      });
    }

    try {
      await yscpRuntimeService.stop();
    } catch (_e) {}
    try {
      await db.close();
    } catch (_e) {}

    process.exit(1);
  }
}

/**
 * 優雅關閉伺服器
 */
const shutdownLogger = logger.createLogger("Shutdown");
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  shutdownLogger.info(`收到 ${signal}，正在關閉伺服器...`);

  try {
    await licenseRuntimeService.stopLicensedBackgroundServices();
    shutdownLogger.info("授權背景服務已停止");

    if (typeof global.__alertRolloverStop === "function") {
      global.__alertRolloverStop();
      global.__alertRolloverStop = null;
    }

    if (global.__backupSchedulerHandle?.stop) {
      global.__backupSchedulerHandle.stop();
      global.__backupSchedulerHandle = null;
    }

    if (global.__externalSyncHandle?.stop) {
      global.__externalSyncHandle.stop();
      global.__externalSyncHandle = null;
    }

    if (global.__recordExportHandle?.stop) {
      global.__recordExportHandle.stop();
      global.__recordExportHandle = null;
    }

    if (global.__httpServer) {
      await new Promise((resolve) => {
        global.__httpServer.close(() => resolve());
      });
      global.__httpServer = null;
    }

    // 關閉資料庫連線
    await db.close();
    await yscpRuntimeService.stop();
    shutdownLogger.info("資料庫連線已關閉");

    shutdownLogger.info("伺服器已優雅關閉");
    process.exit(0);
  } catch (error) {
    shutdownLogger.error("關閉伺服器時發生錯誤", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// 監聽終止信號
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// 處理未捕獲的異常
process.on("uncaughtException", (error) => {
  logger.error("未捕獲的異常", { error });
  gracefulShutdown("uncaughtException");
});

// 處理未處理的 Promise 拒絕
process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error("未處理的 Promise 拒絕", { error });
  // 不立即退出，記錄錯誤即可
});

startServer();
