/**
 * 配置管理模組
 * 
 * 統一管理所有環境變數和配置選項
 * 提供類型轉換和預設值處理
 */

const path = require("path");
const dotenv = require("dotenv");

// 載入環境變數
dotenv.config({
	path: process.env.ENV_FILE || path.resolve(process.cwd(), ".env")
});

/**
 * 轉換為數字
 * @param {string|number} value - 要轉換的值
 * @param {number} fallback - 預設值
 * @returns {number} 轉換後的數字
 */
const toNumber = (value, fallback) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * 轉換為布林值
 * @param {string|boolean} value - 要轉換的值
 * @param {boolean} fallback - 預設值
 * @returns {boolean} 轉換後的布林值
 */
const toBoolean = (value, fallback) => {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lower = value.toLowerCase();
		return lower === "true" || lower === "1" || lower === "yes";
	}
	return fallback;
};

/**
 * 取得環境變數（帶預設值）
 * @param {string} key - 環境變數鍵名
 * @param {*} defaultValue - 預設值
 * @returns {string} 環境變數值或預設值
 */
const getEnv = (key, defaultValue) => {
	return process.env[key] || defaultValue;
};

/**
 * 伺服器配置
 */
const server = {
	host: getEnv("HOST", "0.0.0.0"),
	port: toNumber(getEnv("PORT"), 4000),
	nodeEnv: getEnv("NODE_ENV", "development"),
};

/**
 * Modbus 配置
 */
const modbus = {
	// 設備連線資訊由前端 API 請求中提供，此處僅保留全域設定
	timeout: toNumber(getEnv("MODBUS_TIMEOUT"), 2000),
};

/**
 * 資料庫配置
 */
const database = {
	host: getEnv("DB_HOST", "127.0.0.1"),
	port: toNumber(getEnv("DB_PORT"), 5432),
	user: getEnv("DB_USER", "postgres"),
	password: getEnv("DB_PASSWORD", "postgres"),
	database: getEnv("DB_NAME", "ba_system"),
	connectionLimit: toNumber(getEnv("DB_CONNECTION_LIMIT"), 10),
	waitForConnections: true,
	queueLimit: 0,
};

/**
 * JWT 配置
 */
const jwt = {
	secret: getEnv("JWT_SECRET", "your-secret-key-change-in-production"),
	expiresIn: getEnv("JWT_EXPIRES_IN", "7d"),
};

/**
 * MediaMTX 配置
 */
const mediaMTX = {
	apiUrl: getEnv("MEDIAMTX_API_URL", "http://localhost:9997"),
	hlsUrl: getEnv("MEDIAMTX_HLS_URL", "http://localhost:8888"),
	webrtcUrl: getEnv("MEDIAMTX_WEBRTC_URL", "http://localhost:8889"),
	rtspUrl: getEnv("MEDIAMTX_RTSP_URL", "rtsp://localhost:8554"),
};

/**
 * 監控配置
 */
const monitoring = {
	// 是否啟用背景監控服務（預設為 true）
	enabled: toBoolean(getEnv("MONITORING_ENABLED"), true),
};

/**
 * 外部資料庫配置
 */
const externalDatabase = {
	host: getEnv("EXTERNAL_DB_HOST", "192.168.2.2"),
	port: toNumber(getEnv("EXTERNAL_DB_PORT"), 5432),
	user: getEnv("EXTERNAL_DB_USER", "postgres"),
	password: getEnv("EXTERNAL_DB_PASSWORD", ""),
	database: getEnv("EXTERNAL_DB_NAME", "cms"),
	connectionLimit: toNumber(getEnv("EXTERNAL_DB_CONNECTION_LIMIT"), 5),
};

/**
 * CORS 配置
 */
const cors = {
	origins: (getEnv("CORS_ORIGINS", "http://localhost:3000") || "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean),
};

/**
 * 日誌配置
 */
const logging = {
	level: getEnv("LOG_LEVEL", server.nodeEnv === "production" ? "info" : "debug"),
	enableDebugLogs: toBoolean(getEnv("ENABLE_DEBUG_LOGS"), server.nodeEnv === "development"),
	enableRequestLogs: toBoolean(getEnv("ENABLE_REQUEST_LOGS"), server.nodeEnv === "development"),
	enableDetailedLogs: toBoolean(getEnv("ENABLE_DETAILED_LOGS"), false),
};

module.exports = {
	server,
	modbus,
	database,
	jwt,
	mediaMTX,
	monitoring,
	externalDatabase,
	cors,
	logging,
	// 向後兼容：保留舊的配置結構
	serverHost: server.host,
	serverPort: server.port,
};
