const express = require("express");
const http = require("http");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const os = require("os");
const path = require("path");
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
const C = require("./utils/apiErrorCodes");

// 路由
const modbusRoutes = require("./routes/modbusRoutes");
const userRoutes = require("./routes/userRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const lightingRoutes = require("./routes/lightingRoutes");
const drainageRoutes = require("./routes/drainageRoutes");
const powerRoutes = require("./routes/powerRoutes");
const fireRoutes = require("./routes/fireRoutes");
const hvacRoutes = require("./routes/hvacRoutes");
const airCirculationRoutes = require("./routes/airCirculationRoutes");
const emergencyRescueRoutes = require("./routes/emergencyRescueRoutes");
const smokeAlarmRoutes = require("./routes/smokeAlarmRoutes");
const environmentRoutes = require("./routes/environmentRoutes");
const locationRoutes = require("./routes/locationRoutes");
const peopleCountingRoutes = require("./routes/peopleCountingRoutes");
const vehicleAccessRoutes = require("./routes/vehicleAccessRoutes");
const alertRoutes = require("./routes/alertRoutes");
const externalDataRoutes = require("./routes/externalDataRoutes");
const accessControlRoutes = require("./routes/accessControlRoutes");
const personnelRoutes = require("./routes/personnelRoutes");
const yscpEventRoutes = require("./routes/yscpEventRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const runtimeConfigRoutes = require("./routes/runtimeConfigRoutes");
const { bootstrapRuntimeInfrastructure } = require("./services/platform/runtimeConfigApply");
const multimediaDashboardRoutes = require("./routes/multimediaDashboardRoutes");
const licenseRoutes = require("./routes/licenseRoutes");
const moduleRegistryRoutes = require("./routes/moduleRegistryRoutes");

// 授權（Feature Gate）
const { requireFeature } = require("./middleware/licenseMiddleware");

// 服務
const db = require("./database/db");
const externalDb = require("./database/externalDb");
const websocketService = require("./services/websocket/websocketService");
const initSchema = require("./database/initSchema");

// 背景監控服務
const backgroundMonitor = require("./services/monitoring/backgroundMonitor");
const monitoringTaskRegistry = require("./services/monitoring/monitoringTaskRegistry");

// 備份排程
const backupScheduler = require("./services/backup/backupScheduler");
const {
  startAlertDailyRolloverScheduler,
} = require("./services/alerts/alertRolloverScheduler");
// 環境彙總排程（時／日／月）
const environmentAggregationService = require("./services/environment/environmentAggregationService");
// 門禁 ISAPI 佈防訂閱服務（全面改為佈防模式）
const isapiSubscribeHub = require("./services/isapi/isapiSubscribeHub");

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

      // 2) 僅記錄錯誤請求（>=400）
      return res.statusCode < 400;
    },
  }),
);

// 統一響應格式中間件
app.use(responseHandler);

// 靜態檔案服務（用於提供上傳的檔案）
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
// 若前端僅反代 /api（未反代 /uploads），仍可透過 /api/uploads 取用同一批靜態檔案
app.use("/api/uploads", express.static(path.join(process.cwd(), "uploads")));

// 註冊路由（授權僅控：人流、照明、排水、消防、環境、影像監控、車輛進出；其餘由角色 admin/operator 管理）
app.use("/api/modbus", modbusRoutes);
app.use("/api/users", userRoutes);
app.use("/api/license", licenseRoutes);
app.use("/api/modules", moduleRegistryRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/lighting", requireFeature("lighting"), lightingRoutes);
app.use("/api/drainage", requireFeature("drainage"), drainageRoutes);
app.use("/api/hvac", requireFeature("hvac"), hvacRoutes);
app.use(
  "/api/air-circulation",
  requireFeature("air_circulation"),
  airCirculationRoutes,
);
app.use("/api/power", requireFeature("power"), powerRoutes);
app.use("/api/fire", requireFeature("fire"), fireRoutes);
app.use(
  "/api/emergency-rescue",
  requireFeature("emergency_rescue"),
  emergencyRescueRoutes,
);
app.use(
  "/api/smoke-alarm",
  requireFeature("smoke_alarm"),
  smokeAlarmRoutes,
);
app.use("/api/environment", requireFeature("environment"), environmentRoutes);
app.use("/api/locations", locationRoutes); // 統一地點管理 API
app.use(
  "/api/people-counting",
  requireFeature("people_counting"),
  peopleCountingRoutes,
); // 人流統計
app.use(
  "/api/vehicle-access",
  requireFeature("vehicle_access"),
  vehicleAccessRoutes,
);
app.use("/api/alerts", alertRoutes);
app.use("/api/external-data", externalDataRoutes); // 車輛相關路由在 externalDataRoutes 內依 requireFeature(vehicle_access) 控管
app.use("/api/access-control", accessControlRoutes);
app.use("/api/personnel", personnelRoutes); // 人員主檔、門禁權限（僅角色控制）
app.use("/api/yscp", yscpEventRoutes);
app.use("/api/settings", settingsRoutes); // 系統設定 API
app.use("/api/runtime-config", runtimeConfigRoutes);
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

    // 創建 HTTP 伺服器
    const httpServer = http.createServer(app);

    // 初始化 WebSocket 服務
    websocketService.initializeWebSocket(httpServer);

    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(
        serverConfig.serverPort,
        serverConfig.serverHost,
        resolve,
      );
    });

    serverLogger.info(
      `BA 系統後端服務已啟動，監聽 ${config.serverHost}:${config.serverPort}`,
    );
    serverLogger.info(`本機連線: http://localhost:${config.serverPort}`);
    serverLogger.info(`區域網路連線: http://${localIP}:${config.serverPort}`);
    serverLogger.info(`WebSocket 服務已啟用 (Socket.IO)`);

    if (localIP !== "localhost") {
      serverLogger.info(
        `其他裝置可透過以下網址訪問: http://${localIP}:${config.serverPort}`,
      );
    }

    // 測試資料庫連線（listen 成功後再做，避免啟動失敗時觸發一堆背景任務）
    const dbConnected = await db.testConnection();
    if (!dbConnected) {
      serverLogger.warn("資料庫連線失敗，但伺服器仍會啟動");
    } else {
      serverLogger.info("資料庫連線成功");
    }

    if (dbConnected) {
      await bootstrapRuntimeInfrastructure();
      const externalDbConnected = await externalDb.testConnection();
      if (!externalDbConnected) {
        serverLogger.warn("外部資料庫連線失敗，外部資料功能可能無法使用");
      } else {
        serverLogger.info("外部資料庫連線成功");
      }
    } else {
      serverLogger.warn("主資料庫未連線，略過 runtime 設定載入");
    }

    // 註冊並啟動背景監控任務（固定啟用）
    for (const task of monitoringTaskRegistry) {
      backgroundMonitor.registerMonitoringTask(
        task.systemName,
        task.taskFunction,
        task.options,
      );
    }
    // 人流統計系統：已改為僅依賴 YSCP 事件觸發，不再使用定時任務

    backgroundMonitor.startMonitoring();
    serverLogger.info("背景監控服務已啟用");

    global.__backupSchedulerHandle = backupScheduler.startScheduler();
    serverLogger.info("備份排程已啟用");

    global.__alertRolloverStop = startAlertDailyRolloverScheduler();
    serverLogger.info("警報日界線排程已啟用（依 runtime 營運設定）");

    // 環境彙總：每小時寫入「上一小時」hour（日／月由備份日執行）
    const runHourAgg = async () => {
      try {
        await environmentAggregationService.computeAndSaveHour();
      } catch (err) {
        serverLogger.warn("環境彙總 hour 執行失敗", { error: err.message });
      }
    };
    const runTodayHourBackfill = async () => {
      try {
        await environmentAggregationService.backfillTodayHours();
        serverLogger.info("環境彙總 hour 今日補寫完成");
      } catch (err) {
        serverLogger.warn("環境彙總 hour 今日補寫失敗", { error: err.message });
      }
    };
    setImmediate(async () => {
      await runHourAgg();
      await runTodayHourBackfill();
    });
    global.__envHourAggIntervalId = setInterval(runHourAgg, 60 * 60 * 1000);
    global.__envPartialHourAggIntervalId = setInterval(
      () =>
        environmentAggregationService
          .upsertPartialCurrentHour()
          .catch((err) =>
            serverLogger.warn("環境彙總 partial hour 失敗", {
              error: err.message,
            }),
          ),
      15 * 60 * 1000,
    );
    serverLogger.info("環境彙總排程已啟用（每小時 + 每 15 分鐘 partial hour）");

    // 環境彙總（日）：獨立於備份排程，避免備份停擺導致 week/month 趨勢缺洞
    // - 啟動時先補寫最近 7 天（不含今日）
    // - 之後每天在「下一個 UTC 00:05」跑一次（避免卡在整點跨日）
    const runDayAggBackfill = async () => {
      try {
        await environmentAggregationService.backfillRecentDays(7);
        serverLogger.info("環境彙總 day 補寫完成（最近 7 天）");
      } catch (err) {
        serverLogger.warn("環境彙總 day 補寫失敗", { error: err.message });
      }
    };

    const runDayAgg = async () => {
      try {
        await environmentAggregationService.computeAndSaveDay();
      } catch (err) {
        serverLogger.warn("環境彙總 day 執行失敗", { error: err.message });
      }
    };

    const scheduleDailyAtUtc = (hour, minute, fn) => {
      const now = new Date();
      const next = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          hour,
          minute,
          0,
          0,
        ),
      );
      if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      const delay = Math.max(0, next.getTime() - now.getTime());
      const safeRun = () => Promise.resolve(fn()).catch(() => {});
      const timeoutId = setTimeout(() => {
        void safeRun();
        global.__envDayAggIntervalId = setInterval(
          () => void safeRun(),
          24 * 60 * 60 * 1000,
        );
      }, delay);
      return timeoutId;
    };

    setImmediate(() => void runDayAggBackfill());
    global.__envDayAggTimeoutId = scheduleDailyAtUtc(0, 5, runDayAgg);
    serverLogger.info("環境彙總排程已啟用（每日 UTC 00:05，day bucket）");

    global.__httpServer = httpServer;

    // ISAPI 佈防訂閱中心（門禁 / 人流 PeopleCounting / 車牌 ANPR）
    isapiSubscribeHub.start().catch((err) => {
      serverLogger.warn("ISAPI 佈防訂閱中心啟動時發生錯誤（將不影響其他功能）", {
        error: err.message,
      });
    });
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
      await db.close();
    } catch (_e) {}
    try {
      await externalDb.close();
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
    // 停止背景監控服務
    await backgroundMonitor.stopMonitoring();
    shutdownLogger.info("背景監控服務已停止");

    isapiSubscribeHub.stop();
    shutdownLogger.info("ISAPI 佈防訂閱中心已停止");

    if (global.__envHourAggIntervalId) {
      clearInterval(global.__envHourAggIntervalId);
      global.__envHourAggIntervalId = null;
    }

    if (global.__envDayAggTimeoutId) {
      clearTimeout(global.__envDayAggTimeoutId);
      global.__envDayAggTimeoutId = null;
    }

    if (global.__envDayAggIntervalId) {
      clearInterval(global.__envDayAggIntervalId);
      global.__envDayAggIntervalId = null;
    }

    if (typeof global.__alertRolloverStop === "function") {
      global.__alertRolloverStop();
      global.__alertRolloverStop = null;
    }

    if (global.__backupSchedulerHandle?.stop) {
      global.__backupSchedulerHandle.stop();
      global.__backupSchedulerHandle = null;
    }

    if (global.__httpServer) {
      await new Promise((resolve) => {
        global.__httpServer.close(() => resolve());
      });
      global.__httpServer = null;
    }

    // 關閉資料庫連線
    await db.close();
    await externalDb.close();
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
  logger.error("未捕獲的異常", { error: error.message, stack: error.stack });
  gracefulShutdown("uncaughtException");
});

// 處理未處理的 Promise 拒絕
process.on("unhandledRejection", (reason, promise) => {
  logger.error("未處理的 Promise 拒絕", { reason, promise });
  // 不立即退出，記錄錯誤即可
});

startServer();
