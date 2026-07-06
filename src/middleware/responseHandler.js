/**
 * 統一響應格式中間件
 * 提供統一的 API 響應格式，確保所有響應遵循相同結構
 */

const {
	formatFailurePayload,
	httpStatusForCode,
} = require("../utils/apiErrors");

/**
 * 送出標準錯誤回應
 * @param {Object} res - Express 響應對象
 * @param {{ code: string, message: string, details?: unknown }} payload
 * @param {number} statusCode
 */
function sendFailure(res, payload, statusCode) {
  return res.status(statusCode).json(formatFailurePayload(payload));
}

/**
 * 語意化錯誤（路由／middleware 建議使用）
 * @param {Object} res
 * @param {string} code - apiErrorCodes 常數
 * @param {string} message
 * @param {number} [statusCode] - 省略時依 code 查表
 * @param {unknown} [details]
 */
function sendError(res, code, message, statusCode, details = null) {
  const status = statusCode ?? httpStatusForCode(code);
  return sendFailure(res, { code, message, details }, status);
}

/**
 * 統一成功響應格式
 */
function sendSuccess(res, data, statusCode = 200) {
  if (data && typeof data === "object" && (data.success !== undefined || data.error !== undefined)) {
    return res.status(statusCode).json({
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  const commonKeys = ['zones', 'zone', 'locations', 'location', 'users', 'user', 'alerts', 'alert', 'devices', 'device', 'device_models', 'device_model'];
  
  const hasCommonStructure = data && typeof data === "object" && !Array.isArray(data) && 
    Object.keys(data).some(key => commonKeys.includes(key));

  if (hasCommonStructure || (data && typeof data === "object" && data.message)) {
    return res.status(statusCode).json({
      ...data,
      timestamp: new Date().toISOString(),
    });
  }

  return res.status(statusCode).json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
}

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

function responseHandler(req, res, next) {
  res.sendSuccess = (data, statusCode) => sendSuccess(res, data, statusCode);
  res.sendError = (code, message, statusCode, details) =>
    sendError(res, code, message, statusCode, details);
  res.sendFailure = (payload, statusCode) => sendFailure(res, payload, statusCode);
  res.sendPaginated = (items, total, page, limit) =>
    sendPaginated(res, items, total, page, limit);

  next();
}

module.exports = responseHandler;
module.exports.sendSuccess = sendSuccess;
module.exports.sendError = sendError;
module.exports.sendFailure = sendFailure;
module.exports.sendPaginated = sendPaginated;
