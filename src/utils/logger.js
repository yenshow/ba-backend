/**
 * 日誌管理工具
 * 
 * 提供統一的日誌記錄功能，支持不同日誌級別
 * 在生產環境中，可以使用 winston 等專業日誌庫
 */

const isDevelopment = process.env.NODE_ENV === "development";
const isProduction = process.env.NODE_ENV === "production";

/**
 * 日誌級別
 */
const LOG_LEVELS = {
  ERROR: "error",
  WARN: "warn",
  INFO: "info",
  DEBUG: "debug",
};

/**
 * 日誌前綴格式
 * @param {string} level - 日誌級別
 * @param {string} module - 模組名稱
 * @returns {string} 格式化後的前綴
 */
function formatPrefix(level, module) {
  const timestamp = new Date().toISOString();
  const levelUpper = level.toUpperCase().padEnd(5);
  const moduleName = module ? `[${module}]` : "";

  return `${timestamp} ${levelUpper} ${moduleName}`;
}

function stripModuleFromMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  if (!("module" in meta)) return meta;
  const { module: _module, ...rest } = meta;
  return rest;
}

/**
 * 記錄錯誤日誌
 * @param {string} message - 日誌訊息
 * @param {Object} meta - 元數據（可選）
 */
function error(message, meta = {}) {
  const prefix = formatPrefix(LOG_LEVELS.ERROR, meta.module);
  const metaForPrint = stripModuleFromMeta(meta);
  const metaStr =
    Object.keys(metaForPrint).length > 0 ? JSON.stringify(metaForPrint) : "";

  console.error(`${prefix} ${message}`, metaStr ? metaForPrint : "");

  // 在生產環境中，可以將錯誤發送到日誌服務
  if (isProduction && meta.error && meta.error.stack) {
    // TODO: 發送到日誌服務（如 Sentry、Loggly 等）
  }
}

/**
 * 記錄警告日誌
 * @param {string} message - 日誌訊息
 * @param {Object} meta - 元數據（可選）
 */
function warn(message, meta = {}) {
  const prefix = formatPrefix(LOG_LEVELS.WARN, meta.module);
  const metaForPrint = stripModuleFromMeta(meta);
  const metaStr =
    Object.keys(metaForPrint).length > 0 ? JSON.stringify(metaForPrint) : "";

  console.warn(`${prefix} ${message}`, metaStr ? metaForPrint : "");
}

/**
 * 記錄資訊日誌
 * @param {string} message - 日誌訊息
 * @param {Object} meta - 元數據（可選）
 */
function info(message, meta = {}) {
  const prefix = formatPrefix(LOG_LEVELS.INFO, meta.module);
  const metaForPrint = stripModuleFromMeta(meta);
  const metaStr =
    Object.keys(metaForPrint).length > 0 ? JSON.stringify(metaForPrint) : "";

  console.log(`${prefix} ${message}`, metaStr ? metaForPrint : "");
}

/**
 * 記錄調試日誌（僅在開發環境中顯示）
 * @param {string} message - 日誌訊息
 * @param {Object} meta - 元數據（可選）
 */
function debug(message, meta = {}) {
  if (!isDevelopment && process.env.ENABLE_DEBUG_LOGS !== "true") {
    return;
  }

  const prefix = formatPrefix(LOG_LEVELS.DEBUG, meta.module);
  const metaForPrint = stripModuleFromMeta(meta);
  const metaStr =
    Object.keys(metaForPrint).length > 0 ? JSON.stringify(metaForPrint) : "";

  console.log(`${prefix} ${message}`, metaStr ? metaForPrint : "");
}

/**
 * 建立模組專用的日誌記錄器
 * @param {string} moduleName - 模組名稱
 * @returns {Object} 日誌記錄器對象
 */
function createLogger(moduleName) {
  return {
    error: (message, meta = {}) => error(message, { ...meta, module: moduleName }),
    warn: (message, meta = {}) => warn(message, { ...meta, module: moduleName }),
    info: (message, meta = {}) => info(message, { ...meta, module: moduleName }),
    debug: (message, meta = {}) => debug(message, { ...meta, module: moduleName }),
  };
}

module.exports = {
  error,
  warn,
  info,
  debug,
  createLogger,
  LOG_LEVELS,
};

