/**
 * 統一響應格式中間件
 * 提供統一的 API 響應格式，確保所有響應遵循相同結構
 */

/**
 * 統一成功響應格式
 * @param {Object} res - Express 響應對象
 * @param {*} data - 響應數據
 * @param {number} statusCode - HTTP 狀態碼（預設 200）
 */
function sendSuccess(res, data, statusCode = 200) {
  // 如果 data 已經是完整的響應對象（包含 success、error 等），直接返回
  if (data && typeof data === "object" && (data.success !== undefined || data.error !== undefined)) {
    return res.status(statusCode).json({
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  // 常見響應結構的鍵名列表
  const commonKeys = ['zones', 'zone', 'locations', 'location', 'users', 'user', 'alerts', 'alert', 'devices', 'device', 'device_types', 'device_models', 'device_type', 'device_model'];
  
  // 檢查是否是常見的響應結構（如 { zones: [...] }、{ devices: [...] }）
  const hasCommonStructure = data && typeof data === "object" && !Array.isArray(data) && 
    Object.keys(data).some(key => commonKeys.includes(key));

  // 常見結構或包含 message 的對象直接返回並添加 timestamp，其他包裝為標準格式
  if (hasCommonStructure || (data && typeof data === "object" && data.message)) {
    return res.status(statusCode).json({
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  // 其他情況包裝為標準格式
  return res.status(statusCode).json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
}

/**
 * 統一錯誤響應格式（應使用 errorHandler 中間件）
 * @param {Object} res - Express 響應對象
 * @param {string} message - 錯誤訊息
 * @param {number} statusCode - HTTP 狀態碼（預設 400）
 */
function sendError(res, message, statusCode = 400) {
  res.status(statusCode).json({
    error: true,
    message,
    timestamp: new Date().toISOString(),
  });
}

/**
 * 統一分頁響應格式
 * @param {Object} res - Express 響應對象
 * @param {Array} items - 數據列表
 * @param {number} total - 總數
 * @param {number} page - 當前頁碼
 * @param {number} limit - 每頁數量
 */
function sendPaginated(res, items, total, page, limit) {
  res.json({
    success: true,
    data: items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * 擴展 Express 響應對象
 * @param {Object} req - Express 請求對象
 * @param {Object} res - Express 響應對象
 * @param {Function} next - Express next 函數
 */
function responseHandler(req, res, next) {
  // 擴展 res 對象，添加統一的響應方法
  res.sendSuccess = (data, statusCode) => sendSuccess(res, data, statusCode);
  res.sendError = (message, statusCode) => sendError(res, message, statusCode);
  res.sendPaginated = (items, total, page, limit) =>
    sendPaginated(res, items, total, page, limit);

  next();
}

module.exports = responseHandler;
module.exports.sendSuccess = sendSuccess;
module.exports.sendError = sendError;
module.exports.sendPaginated = sendPaginated;

