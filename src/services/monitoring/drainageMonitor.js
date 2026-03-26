/**
 * 衛生排水系統監控任務
 * 定期讀取所有排水點位狀態，並同步警報（bit_state / error_count）
 */
 
const logger = require("../../utils/logger");
const drainageStatusService = require("../systems/drainageStatusService");

/**
 * 檢查所有排水系統（以 getStatusSnapshot 為單一入口）
 * - 此服務內部會讀取每個 system 的狀態點位
 * - 並同步：連線離線 error_count、位元狀態 bit_state 警報
 */
async function checkDrainageSystems() {
  const monitorLogger = logger.createLogger("drainageMonitor");
  try {
    await drainageStatusService.getStatusSnapshot();
  } catch (error) {
    monitorLogger.warn("排水監控執行失敗（不影響其他任務）", {
      error: error?.message || String(error),
    });
  }
}

module.exports = {
  checkDrainageSystems,
};

