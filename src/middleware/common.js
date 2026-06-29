/**
 * 通用中間件
 *
 * 包含常用的中間件功能，如禁用快取、請求日誌等
 */

/**
 * 設定 HTTP 回應標頭，禁止瀏覽器／代理快取 API 結果。
 * 注意：與快照 REST query `?noCache=true`（略過 monitoringSnapshotCache、觸發 Modbus）無關。
 */
const disableHttpCache = (req, res, next) => {
  res.set({
    "Cache-Control": "no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
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
  disableHttpCache,
  securityHeaders,
};
