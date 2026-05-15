/**
 * 統一錯誤處理中間件
 *
 * 提供統一的錯誤處理邏輯，根據錯誤類型自動決定 HTTP 狀態碼
 * 並記錄設備錯誤（如 Modbus 連接失敗）
 */

const systemAlert = require("../services/alerts/systemAlertHelper");
const logger = require("../utils/logger");
const {
  formatFailurePayload,
  getHttpStatusFromError,
  resolveErrorCode,
  resolveErrorDetails,
} = require("../utils/apiErrorFormatter");

const DEVICE_ERROR_COOLDOWN_MS = Number(
  process.env.DEVICE_ERROR_COOLDOWN_MS || 30_000,
);
const lastDevice503LogAt = new Map();
const lastDeviceErrorAlertAt = new Map();

const getClientFacingErrorMessage = (req, statusCode, internalMessage) => {
  const external = String(req.originalUrl || req.url || "").includes(
    "/api/external-data",
  );
  if (external && (statusCode === 503 || statusCode === 500)) {
    return "資料庫查詢錯誤";
  }
  return internalMessage;
};

const getDeviceErrorKey = (req, errorMessage) => {
  const host = req.query?.host ? String(req.query.host) : "";
  const port =
    req.query?.port !== undefined && req.query?.port !== null
      ? String(req.query.port)
      : "";
  const unitId =
    req.query?.unitId !== undefined && req.query?.unitId !== null
      ? String(req.query.unitId)
      : "";
  return `${req.path}|${host}:${port}:${unitId}|${errorMessage || ""}`;
};

const shouldCooldown = (store, key) => {
  const now = Date.now();
  const lastAt = store.get(key);
  if (lastAt !== undefined && now - lastAt < DEVICE_ERROR_COOLDOWN_MS) {
    return true;
  }
  store.set(key, now);
  if (store.size > 2000) {
    for (const [k, ts] of store.entries()) {
      if (now - ts > DEVICE_ERROR_COOLDOWN_MS) {
        store.delete(k);
      }
    }
  }
  return false;
};

async function recordDeviceError(req, errorMessage) {
  try {
    if (req.path && req.path.startsWith("/api/modbus")) {
      const cooldownKey = getDeviceErrorKey(req, errorMessage);

      const deviceConfig = {
        host: req.query?.host,
        port: req.query?.port ? Number(req.query.port) : undefined,
        unitId: req.query?.unitId ? Number(req.query.unitId) : undefined,
      };

      if (deviceConfig.host && deviceConfig.port !== undefined) {
        if (shouldCooldown(lastDeviceErrorAlertAt, cooldownKey)) {
          return;
        }
        await systemAlert.notifyModbusHttpDeviceFailed(
          deviceConfig,
          errorMessage,
          { skipWebSocket: true },
        );
      }
    }
  } catch (trackError) {
    logger.warn("記錄設備錯誤失敗", { error: trackError.message });
  }
}

async function errorHandler(err, req, res, next) {
  const statusCode = getHttpStatusFromError(err, req);
  const errorMessage = err.message || "Request failed";
  const clientMessage = getClientFacingErrorMessage(req, statusCode, errorMessage);

  if (statusCode === 503) {
    const isModbusRequest = req.path && req.path.startsWith("/api/modbus");
    if (isModbusRequest) {
      const cooldownKey = getDeviceErrorKey(req, errorMessage);
      if (!shouldCooldown(lastDevice503LogAt, cooldownKey)) {
        logger.warn(`[503] ${errorMessage}`, {
          path: req.path,
          method: req.method,
          host: req.query?.host,
          port: req.query?.port,
          unitId: req.query?.unitId,
        });
      }
    } else {
      logger.warn(`[503] ${errorMessage}`, {
        path: req.path,
        method: req.method,
      });
    }

    await recordDeviceError(req, errorMessage);
  } else if (statusCode >= 500) {
    logger.error("伺服器錯誤", {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      statusCode,
    });
  } else {
    logger.warn("請求錯誤", {
      error: errorMessage,
      path: req.path,
      method: req.method,
      statusCode,
    });
  }

  res.status(statusCode).json(
    formatFailurePayload({
      code: resolveErrorCode(err, statusCode),
      message: clientMessage,
      details: resolveErrorDetails(err),
    }),
  );
}

module.exports = errorHandler;
