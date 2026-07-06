/**
 * API 錯誤回應組裝（供 responseHandler / errorHandler 共用）
 */
const { isAppError } = require("./AppError");
const { codeForHttpStatus } = require("./meta");

function formatFailurePayload(payload) {
  const { code, message, details = null } = payload;
  return {
    success: false,
    error: {
      code,
      message,
      details: details === undefined ? null : details,
    },
    timestamp: new Date().toISOString(),
  };
}

function getHttpStatusFromError(err) {
  const sc = err?.statusCode;
  if (Number.isFinite(sc) && sc >= 400 && sc <= 599) {
    return sc;
  }
  return 500;
}

function resolveErrorCode(err, statusCode) {
  if (isAppError(err) && err.code) {
    return err.code;
  }
  return codeForHttpStatus(statusCode);
}

function resolveErrorDetails(err) {
  if (isAppError(err)) {
    return err.details ?? null;
  }
  return null;
}

module.exports = {
  formatFailurePayload,
  getHttpStatusFromError,
  resolveErrorCode,
  resolveErrorDetails,
};
