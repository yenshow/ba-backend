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
  path: process.env.ENV_FILE || path.resolve(process.cwd(), ".env"),
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
  port: toNumber(getEnv("DB_PORT"), 5433),
  user: getEnv("DB_USER", "postgres"),
  password: getEnv("DB_PASSWORD", "postgres"),
  database: getEnv("DB_NAME", "ba_system"),
  connectionLimit: 10,
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
 * 監控配置
 */
const monitoring = {
  enabled: true,
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
  connectionLimit: 10,
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
  level: getEnv(
    "LOG_LEVEL",
    server.nodeEnv === "production" ? "info" : "debug",
  ),
  enableDebugLogs: toBoolean(
    getEnv("ENABLE_DEBUG_LOGS"),
    server.nodeEnv === "development",
  ),
  enableRequestLogs: toBoolean(
    getEnv("ENABLE_REQUEST_LOGS"),
    server.nodeEnv === "development",
  ),
};

/**
 * 功能旗標（分版本：YSCP 人流 / 門禁人員）
 * 預設皆 true（兩流程並存）；設為 false 可關閉對應路由或行為。
 */
const features = {
  enableYscpPeopleCounting: toBoolean(
    getEnv("ENABLE_YSCP_PEOPLE_COUNTING"),
    true,
  ),
  enableAccessControlPersonnel: toBoolean(
    getEnv("ENABLE_ACCESS_CONTROL_PERSONNEL"),
    true,
  ),
};

/**
 * 授權部署樣貌：與前端產品線對應，決定本後端可正規化／啟用的 feature keys
 * - central：智慧管理平台（全模組）
 * - construction：工地管理平台（子集）
 */
const resolveLicenseDeploymentProfile = () => {
  const raw = String(
    getEnv("LICENSE_DEPLOYMENT_PROFILE", "central") || "central",
  )
    .trim()
    .toLowerCase();
  return raw === "construction" ? "construction" : "central";
};

/**
 * 授權配置
 * LICENSE_OPEN_ALL_FEATURES=true 時暫時開放所有功能（不檢查 system_settings 授權）
 */
const license = {
  openAllFeatures: toBoolean(getEnv("LICENSE_OPEN_ALL_FEATURES"), false),
  deploymentProfile: resolveLicenseDeploymentProfile(),
  // 授權平台 API（線上啟用）Base URL，例如 https://api.yenshow.com/api/license
  platformApiBaseUrl: getEnv("LICENSE_PLATFORM_API_BASE_URL", ""),
  // 授權平台 API 逾時（毫秒）
  platformTimeoutMs: toNumber(getEnv("LICENSE_PLATFORM_TIMEOUT_MS"), 8000),
  // 離線授權回應檔驗簽用（HMAC-SHA256）
  signSecret: getEnv("LICENSE_SIGN_SECRET", ""),
};

/**
 * YSCP API 配置
 */
const yscp = {
  host: getEnv("YSCP_HOST", "https://192.168.2.2"),
  accessKey: getEnv("YSCP_AK", ""),
  secretKey: getEnv("YSCP_SK", ""),
  apiVersion: getEnv("YSCP_API_VER", "v1"),
  rejectUnauthorized: toBoolean(getEnv("YSCP_REJECT_UNAUTHORIZED"), false), // 是否拒絕自簽名證書（預設為 false，允許自簽名證書）
};

/**
 * 警報每日結案（日界線）：批次 active→resolved、連動 DO 復歸、忽視僅當曆日阻擋
 */
const alerts = {
  dailyRolloverEnabled: true,
  dailyRolloverTimezone: getEnv("ALERT_DAILY_ROLLOVER_TZ", "Asia/Taipei"),
  dailyRolloverLocalHour: Math.min(
    23,
    Math.max(0, toNumber(getEnv("ALERT_DAILY_ROLLOVER_LOCAL_HOUR"), 0)),
  ),
  dailyRolloverLocalMinute: Math.min(
    59,
    Math.max(0, toNumber(getEnv("ALERT_DAILY_ROLLOVER_LOCAL_MINUTE"), 5)),
  ),
};

/**
 * MediaMTX 配置（RTSP ingest + WebRTC 分發）
 * 用於攝影機串流：後端依 deviceId 呼叫 API 增刪 path，回傳 webrtcUrl 給前端
 */
const mediaMTX = {
  // Control API 位址（例：http://127.0.0.1:9997）
  apiBaseUrl: getEnv("MEDIAMTX_API_BASE_URL", "http://127.0.0.1:9997"),
  // WebRTC WHEP 基礎 URL（瀏覽器連線用，例：http://192.168.2.8:8889）
  webrtcBaseUrl: getEnv("MEDIAMTX_WEBRTC_BASE_URL", "http://127.0.0.1:8889"),
  timeoutMs: 10000,
};

module.exports = {
  server,
  modbus,
  database,
  jwt,
  monitoring,
  externalDatabase,
  features,
  license,
  yscp,
  alerts,
  mediaMTX,
  cors,
  logging,
  // 向後兼容：保留舊的配置結構
  serverHost: server.host,
  serverPort: server.port,
};
