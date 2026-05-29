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

/** PM2／封裝環境見 `scripts/generate-ecosystem.cjs`（`NODE_ENV: "production"`）；其餘視為非 production（較詳細的 debug／連線 log） */
const isProduction = process.env.NODE_ENV === "production";

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
  timeout: 10000,
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
 * CORS 配置
 */
const cors = {
  origins: (getEnv("CORS_ORIGINS", "http://localhost:3000") || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};

/**
 * 功能旗標（YSCP 外部資料源）
 * 預設 true；設為 false 時略過對應 data_source=yscp 與外部 DB 查詢。
 */
const features = {
  enableYscpPeopleCounting: toBoolean(
    getEnv("ENABLE_YSCP_PEOPLE_COUNTING"),
    true,
  ),
  enableYscpVehicleAccess: toBoolean(
    getEnv("ENABLE_YSCP_VEHICLE_ACCESS"),
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
  platformTimeoutMs: 10000,
  // 離線授權回應檔驗簽用（HMAC-SHA256）
  signSecret: getEnv("LICENSE_SIGN_SECRET", ""),
};

/** 1–65535 埠；優先讀 PORT 鍵，否則從舊版 *_BASE_URL 解析（相容） */
const mediaMtxPort = (portKey, legacyUrlKey, fallback) => {
  const fromPort = getEnv(portKey, "").trim();
  if (fromPort) {
    return Math.min(65535, Math.max(1, toNumber(fromPort, fallback)));
  }
  const legacy = getEnv(legacyUrlKey, "").trim();
  if (legacy) {
    try {
      const u = new URL(legacy);
      if (u.port) {
        return Math.min(65535, Math.max(1, toNumber(u.port, fallback)));
      }
    } catch {
      // ignore
    }
  }
  return fallback;
};

/**
 * MediaMTX（後端 Control API 固定本機；瀏覽器 WHEP 埠由前端依目前 hostname 組裝）
 */
const mediaMTX = {
  apiPort: mediaMtxPort("MEDIAMTX_API_PORT", "MEDIAMTX_API_BASE_URL", 9997),
  webrtcPort: mediaMtxPort("MEDIAMTX_WEBRTC_PORT", "", 8889),
  timeoutMs: 10000,
};
mediaMTX.apiBaseUrl = `http://127.0.0.1:${mediaMTX.apiPort}`;

module.exports = {
  server,
  isProduction,
  modbus,
  database,
  jwt,
  features,
  license,
  mediaMTX,
  cors,
  // 向後兼容：保留舊的配置結構
  serverHost: server.host,
  serverPort: server.port,
};
