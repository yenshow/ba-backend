/**
 * 統一錯誤處理中間件
 *
 * 提供統一的錯誤處理邏輯，根據錯誤類型自動決定 HTTP 狀態碼
 * 並記錄設備錯誤（如 Modbus 連接失敗）
 */

const systemAlert = require("../services/alerts/systemAlertHelper");
const logger = require("../utils/logger");

/**
 * 記錄設備錯誤（如 Modbus 連接失敗時關聯設備告警）
 * @param {Object} req - Express 請求對象
 * @param {string} errorMessage - 錯誤訊息
 */
async function recordDeviceError(req, errorMessage) {
  try {
    if (req.path && req.path.startsWith("/api/modbus")) {
      const deviceConfig = {
        host: req.query?.host,
        port: req.query?.port ? Number(req.query.port) : undefined,
        unitId: req.query?.unitId ? Number(req.query.unitId) : undefined,
      };

      if (deviceConfig.host && deviceConfig.port !== undefined) {
        const deviceId = await systemAlert.getDeviceIdFromConfig(deviceConfig);
        if (deviceId) {
          await systemAlert.recordError("device", deviceId, errorMessage);
        }
      }
    }
  } catch (trackError) {
    logger.warn("記錄設備錯誤失敗", { error: trackError.message });
  }
}

/**
 * 判斷錯誤類型並返回對應的 HTTP 狀態碼
 * @param {Error} err - 錯誤對象
 * @returns {number} HTTP 狀態碼
 */
function getErrorStatusCode(err) {
  const message = err.message || "";

  // 認證錯誤
  if (
    message.includes("未提供認證") ||
    message.includes("無效的 Token") ||
    message.includes("認證失敗") ||
    message.includes("未認證") ||
    err.statusCode === 401
  ) {
    return 401; // Unauthorized
  }

  // 權限錯誤
  if (
    message.includes("權限不足") ||
    message.includes("只有管理員") ||
    message.includes("只能修改") ||
    err.statusCode === 403
  ) {
    return 403; // Forbidden
  }

  // 參數錯誤
  if (
    message.includes("must be") ||
    message.includes("required") ||
    message.includes("必須") ||
    message.includes("格式不正確") ||
    message.includes("已存在") ||
    message.includes("不存在") ||
    err.statusCode === 400
  ) {
    return 400; // Bad Request
  }

  // 資源不存在
  if (err.statusCode === 404) {
    return 404; // Not Found
  }

  // 服務不可用（如 Modbus 連接錯誤、設備離線、讀寫逾時）
  if (
    message.includes("連接超時") ||
    message.includes("連接被拒絕") ||
    message.includes("無法到達設備") ||
    message.includes("連接已斷開") ||
    message.includes("超時") ||
    /timed?\s*out/i.test(message) ||
    err.statusCode === 503
  ) {
    return 503; // Service Unavailable
  }

  // 預設返回 500
  return err.statusCode || 500;
}

/**
 * 統一錯誤處理中間件
 * @param {Error} err - 錯誤對象
 * @param {Object} req - Express 請求對象
 * @param {Object} res - Express 響應對象
 * @param {Function} next - Express next 函數
 */
async function errorHandler(err, req, res, next) {
  const statusCode = getErrorStatusCode(err);
  const errorMessage = err.message || "Request failed";

  // 記錄錯誤日誌
  if (statusCode >= 500) {
    // 伺服器錯誤：記錄完整堆疊
    logger.error("伺服器錯誤", {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      statusCode,
    });
  } else if (statusCode === 503) {
    // 服務不可用（設備離線等）：簡潔日誌
    logger.warn(`[503] ${errorMessage}`, {
      path: req.path,
      method: req.method,
    });

    await recordDeviceError(req, errorMessage);
  } else {
    // 其他錯誤：記錄基本信息
    logger.warn("請求錯誤", {
      error: errorMessage,
      path: req.path,
      method: req.method,
      statusCode,
    });
  }

  // 統一錯誤響應格式
  const response = {
    error: true,
    message: errorMessage,
    details: errorMessage,
    timestamp: new Date().toISOString(),
  };

  // 開發環境下包含堆疊信息
  if (process.env.NODE_ENV === "development" && statusCode >= 500) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = errorHandler;
