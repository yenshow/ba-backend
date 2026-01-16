/**
 * 通用中間件
 * 
 * 包含常用的中間件功能，如禁用快取、請求日誌等
 */

/**
 * 禁用快取的中間件
 * 用於 API 響應，確保客戶端不緩存結果
 */
const noCache = (req, res, next) => {
  res.set({
    "Cache-Control": "no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  next();
};

/**
 * 請求日誌中間件（可選）
 * 記錄請求詳情，用於調試
 */
const requestLogger = (req, res, next) => {
  // 只在開發環境或啟用調試日誌時記錄
  if (
    process.env.NODE_ENV === "development" ||
    process.env.ENABLE_REQUEST_LOGS === "true"
  ) {
    const logger = require("../utils/logger");
    logger.debug("收到請求", {
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body,
      ip: req.ip,
    });
  }
  next();
};

/**
 * 安全標頭中間件
 * 添加基本的安全 HTTP 標頭
 */
const securityHeaders = (req, res, next) => {
  // 防止點擊劫持
  res.setHeader("X-Frame-Options", "DENY");
  
  // 防止 MIME 類型嗅探
  res.setHeader("X-Content-Type-Options", "nosniff");
  
  // XSS 保護
  res.setHeader("X-XSS-Protection", "1; mode=block");
  
  next();
};

module.exports = {
  noCache,
  requestLogger,
  securityHeaders,
};

