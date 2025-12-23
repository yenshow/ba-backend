const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const os = require("os");
const path = require("path");
const config = require("./config");
const modbusRoutes = require("./routes/modbusRoutes");
const userRoutes = require("./routes/userRoutes");
const rtspRoutes = require("./routes/rtspRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const rtspStreamService = require("./services/communication/rtspStreamService");
const deviceErrorTracker = require("./services/alerts/deviceErrorTracker");
const db = require("./database/db");

// 監聽 RTSP 串流服務的錯誤事件，避免未處理的錯誤導致程序崩潰
rtspStreamService.on("error", (errorInfo) => {
	// 只記錄簡潔的錯誤信息，不輸出完整堆疊跟踪
	const errorMsg = errorInfo.error?.message || "未知錯誤";
	console.error(`[RTSP Stream Service] 串流錯誤 (${errorInfo.streamId}): ${errorMsg}`);
	// 不拋出錯誤，只記錄，避免程序崩潰
});

rtspStreamService.on("end", (streamInfo) => {
	console.log(`[RTSP Stream Service] 串流正常結束:`, streamInfo.streamId);
});

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);
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

app.use(cors(corsOptions));
// 增加請求體大小限制（用於上傳圖片等大文件，例如 base64 編碼的圖片）
// 10MB 限制應該足夠應對大多數情況
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// 過濾掉 /ws 請求的日誌，避免日誌被刷屏
app.use(
	morgan("dev", {
    skip: (req) => req.url === "/ws",
	})
);

app.use("/api/modbus", modbusRoutes);
app.use("/api/users", userRoutes);
app.use("/api/rtsp", rtspRoutes);
app.use("/api/devices", deviceRoutes);
const lightingRoutes = require("./routes/lightingRoutes");
app.use("/api/lighting", lightingRoutes);
const environmentRoutes = require("./routes/environmentRoutes");
app.use("/api/environment", environmentRoutes);
const alertRoutes = require("./routes/alertRoutes");
app.use("/api/alerts", alertRoutes);

// 注意：HLS 串流現在由 MediaMTX 提供，不再需要本地靜態文件服務
// MediaMTX 在 http://localhost:8888 提供 HLS 服務

// 處理 WebSocket 升級請求（來自 Nuxt Content 熱重載等）
// 靜默返回 404，不記錄日誌
app.get("/ws", (_req, res) => {
	res.status(404).end();
});

app.use((err, _req, res, _next) => {
	// 根據錯誤類型決定 HTTP 狀態碼
	let statusCode = 500;

	// 認證錯誤
  if (
    err.message &&
    (err.message.includes("未提供認證") ||
      err.message.includes("無效的 Token") ||
      err.message.includes("認證失敗"))
  ) {
		statusCode = 401; // Unauthorized
	}
	// 權限錯誤
  else if (
    err.message &&
    (err.message.includes("權限不足") ||
      err.message.includes("只有管理員") ||
      err.message.includes("只能修改"))
  ) {
		statusCode = 403; // Forbidden
	}
	// 參數錯誤
	else if (
		err.message &&
		(err.message.includes("must be") ||
			err.message.includes("required") ||
			err.message.includes("必須") ||
			err.message.includes("格式不正確") ||
			err.message.includes("已存在") ||
			err.message.includes("不存在"))
	) {
		statusCode = 400; // Bad Request
	}
	// 服務不可用（Modbus 相關）
	else if (
		err.message &&
    (err.message.includes("連接超時") ||
      err.message.includes("連接被拒絕") ||
      err.message.includes("無法到達設備") ||
      err.message.includes("連接已斷開"))
	) {
		statusCode = 503; // Service Unavailable
		// 對於設備離線錯誤，使用簡潔的日誌輸出，避免重複堆疊
		// eslint-disable-next-line no-console
		console.error(`[503] ${err.message}`);

		// 如果是 Modbus 相關的錯誤，記錄設備錯誤（連續5次才觸發警報）
		if (req.path && req.path.startsWith("/api/modbus")) {
			// 從查詢參數中提取設備配置
			const deviceConfig = {
				host: req.query?.host,
				port: req.query?.port ? Number(req.query.port) : undefined,
				unitId: req.query?.unitId ? Number(req.query.unitId) : undefined
			};

			// 如果有有效的設備配置，記錄錯誤
			if (deviceConfig.host && deviceConfig.port !== undefined) {
				// 異步處理，不阻塞錯誤響應
				deviceErrorTracker
					.getDeviceIdFromConfig(deviceConfig)
					.then((deviceId) => {
						if (deviceId) {
							// 將通訊錯誤整合到離線警報中
							return deviceErrorTracker.recordDeviceError(
								deviceId,
								"offline",
								err.message
							);
						}
						return false;
					})
					.catch((trackError) => {
						// 靜默處理追蹤錯誤，避免影響主錯誤響應
						console.error("[server] 記錄設備錯誤失敗:", trackError.message);
					});
			}
		}
	}
	// RTSP 連接錯誤
	else if (
		err.message &&
    (err.message.includes("無法連接到 RTSP") ||
      err.message.includes("RTSP 認證失敗") ||
      err.message.includes("RTSP 串流路徑不存在") ||
      err.message.includes("RTSP 連接失敗"))
	) {
		statusCode = 503; // Service Unavailable
		// 對於 RTSP 連接錯誤，使用簡潔的日誌輸出
		// eslint-disable-next-line no-console
		console.error(`[503] ${err.message}`);

		// 如果是 RTSP 相關的錯誤，記錄設備錯誤（連續5次才觸發警報）
		if (req.path && req.path.startsWith("/api/rtsp")) {
			// 從請求中提取設備 ID（RTSP 路由可能使用不同的參數結構）
			// 這裡需要根據實際的 RTSP 路由結構來調整
			const deviceId = req.body?.device_id || req.query?.device_id || req.params?.deviceId;
			if (deviceId) {
				// 異步處理，不阻塞錯誤響應
				deviceErrorTracker
					.recordDeviceError(Number(deviceId), "offline", err.message)
					.catch((trackError) => {
						// 靜默處理追蹤錯誤，避免影響主錯誤響應
						console.error("[server] 記錄設備錯誤失敗:", trackError.message);
					});
			}
		}
	} else {
		// 其他錯誤輸出完整堆疊
		// eslint-disable-next-line no-console
		console.error(err);
	}

	res.status(statusCode).json({
		error: true,
		message: err.message || "Request failed",
		details: err.message,
    timestamp: new Date().toISOString(),
	});
});

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

// 啟動伺服器
async function startServer() {
	// 測試資料庫連線
	const dbConnected = await db.testConnection();
	if (!dbConnected) {
		console.error("⚠️  警告: 資料庫連線失敗，但伺服器仍會啟動");
	}

	const localIP = getLocalIPAddress();

	app.listen(config.serverPort, config.serverHost, () => {
		// eslint-disable-next-line no-console
    console.log(
      `🚀 BA 系統後端服務已啟動，監聽 ${config.serverHost}:${config.serverPort}`
    );
		console.log(`📍 本機連線: http://localhost:${config.serverPort}`);
		console.log(`📍 區域網路連線: http://${localIP}:${config.serverPort}`);
		if (localIP !== "localhost") {
			console.log(`\n💡 其他裝置可透過以下網址訪問:`);
			console.log(`   http://${localIP}:${config.serverPort}`);
		}
	});
}

// 優雅關閉
process.on("SIGTERM", async () => {
	console.log("收到 SIGTERM，正在關閉伺服器...");
	await rtspStreamService.stopAllStreams();
	await db.close();
	process.exit(0);
});

process.on("SIGINT", async () => {
	console.log("收到 SIGINT，正在關閉伺服器...");
	await rtspStreamService.stopAllStreams();
	await db.close();
	process.exit(0);
});

startServer();
