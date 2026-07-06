/**
 * 後端 API 錯誤單一入口（codes 仍見 ../apiErrorCodes.js）
 */
const AppError = require("./AppError");
const meta = require("./meta");
const format = require("./format");

module.exports = {
  AppError,
  isAppError: AppError.isAppError,
  ...meta,
  ...format,
};
