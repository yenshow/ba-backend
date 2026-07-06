/**
 * 應用層可攜帶 HTTP 狀態與穩定 error code 的錯誤類別
 */
class AppError extends Error {
  /**
   * @param {string} message - 人類可讀訊息
   * @param {{ statusCode?: number, code?: string, details?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "AppError";
    const { statusCode = 500, code, details = null } = options;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function isAppError(err) {
  return Boolean(err && (err instanceof AppError || err.name === "AppError"));
}

module.exports = AppError;
module.exports.isAppError = isAppError;
