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
 * 監控配置
 */
const monitoring = {
  enabled: true,
};

/**
 * 外部 CMS（YSCP）：YSCP_HOST 為 IP／hostname（勿含 https://）；埠／使用者／庫名固定
 */
const yscpHost = getEnv("YSCP_HOST", "192.168.2.2")
  .replace(/^https?:\/\//i, "")
  .split("/")[0]
  .split(":")[0];

const externalDatabase = {
  host: yscpHost,
  port: 5432,
  user: "postgres",
  password: getEnv("YSCP_DB_PASSWORD", ""),
  database: "cms",
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
 * 功能旗標（YSCP 人流資料源）
 * 預設 true；設為 false 時見 peopleCountingService（略過 data_source=yscp）。
 */
const features = {
  enableYscpPeopleCounting: toBoolean(
    getEnv("ENABLE_YSCP_PEOPLE_COUNTING"),
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

/**
 * YSCP HTTP API 配置（與 externalDatabase 共用 YSCP_HOST）
 */
const yscp = {
  host: `https://${yscpHost}`,
  accessKey: getEnv("YSCP_AK", ""),
  secretKey: getEnv("YSCP_SK", ""),
  apiVersion: "v1",
  rejectUnauthorized: false, // 是否拒絕自簽名證書（預設為 false，允許自簽名證書）
};

/**
 * 警報每日結案（日界線）：批次 active→resolved、連動 DO 復歸、忽視僅當曆日阻擋
 */
const alerts = {
  /** 警報結案（resolved）時是否依 rule_id 復歸 alert_linkages DO（預設開） */
  linkageRevertOnResolve: true,
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

/** 選填：非 loopback 的 MEDIAMTX_WEBRTC_BASE_URL → 固定 WHEP 主機（進階） */
const mediaMtxWebRtcFixedBase = () => {
  const raw = getEnv("MEDIAMTX_WEBRTC_BASE_URL", "").trim();
  if (!raw || raw.toLowerCase() === "auto") return null;
  try {
    const host = new URL(raw).hostname;
    if (host === "127.0.0.1" || host === "localhost") return null;
  } catch {
    return raw.replace(/\/$/, "");
  }
  return raw.replace(/\/$/, "");
};

/**
 * MediaMTX（後端 Control API 固定本機；瀏覽器 WHEP 埠由前端帶入目前 hostname）
 */
const mediaMTX = {
  apiPort: mediaMtxPort("MEDIAMTX_API_PORT", "MEDIAMTX_API_BASE_URL", 9997),
  webrtcPort: mediaMtxPort("MEDIAMTX_WEBRTC_PORT", "MEDIAMTX_WEBRTC_BASE_URL", 8889),
  webrtcBaseUrl: mediaMtxWebRtcFixedBase(),
  timeoutMs: 10000,
};
mediaMTX.apiBaseUrl = `http://127.0.0.1:${mediaMTX.apiPort}`;

module.exports = {
  server,
  isProduction,
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
  // 向後兼容：保留舊的配置結構
  serverHost: server.host,
  serverPort: server.port,
};
