const alertService = require("./alertService");
const logger = require("../../utils/logger");

const ignoreLogger = logger.createLogger("AlertIgnoreService");
const getErrorTracker = () => require("./errorTracker");

/**
 * 取消忽視警示（支持多系統來源）
 * - 為了完全切斷 `alertService` ↔ `errorTracker` 循環依賴，將「取消忽視後同步 error_tracking」移出 alertService
 * @param {number} sourceId - 來源 ID（設備 ID、位置 ID 等）
 * @param {string} alertType - 警報類型
 * @param {string} source - 系統來源（可選，默認為 device）
 * @param {string|null} dimensionKey - 維度鍵（可選）
 * @returns {Promise<number>} 取消忽視的警示數量
 */
async function unignoreAlerts(
  sourceId,
  alertType,
  source = alertService.ALERT_SOURCES.DEVICE,
  dimensionKey = null,
) {
  const count = await alertService.updateAlertStatus(
    sourceId,
    source,
    alertType,
    alertService.ALERT_STATUS.ACTIVE,
    null,
    { dimensionKey },
  );

  try {
    await getErrorTracker().reconcileTrackingAfterUnignore(source, sourceId, alertType);
  } catch (error) {
    // 不阻斷 unignore：狀態已恢復，tracking 補償可由後續監控/clearError 自動修復
    ignoreLogger.warn("reconcileTrackingAfterUnignore failed (non-blocking)", {
      error: error.message,
      source,
      sourceId,
      alertType,
      dimensionKey,
    });
  }

  return count;
}

module.exports = {
  unignoreAlerts,
};

