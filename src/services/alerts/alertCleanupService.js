/**
 * 警報自動清理服務
 * 使用統一備份服務進行自動備份並清理過期警報
 */

const backupScheduler = require("../backup/backupScheduler");
const backupConfig = require("../backup/backupConfig");

/**
 * 執行完整的清理流程（備份並刪除超過保留期的警報）
 * @returns {Promise<Object>} 清理結果
 */
async function runCleanup() {
  return await backupScheduler.runAlertsCleanup();
}

// 向後兼容：archiveOldAlerts 是 runCleanup 的別名
const archiveOldAlerts = runCleanup;

/**
 * 刪除超過保留期的備份檔案
 * @returns {Promise<number>} 刪除的檔案數量
 */
async function deleteOldBackups() {
  const backupService = require("../backup/backupService");
  return await backupService.deleteOldBackups("alerts", backupConfig.retention.backup.alerts);
}

/**
 * 啟動定時清理任務
 */
function startCleanupScheduler() {
  const scheduler = backupScheduler.startScheduler();
  console.log("✅ 警報自動清理服務已啟用");
  return scheduler;
}

module.exports = {
  runCleanup,
  archiveOldAlerts,
  deleteOldBackups,
  startCleanupScheduler,
  DB_RETENTION_DAYS: backupConfig.retention.database.alerts,
  BACKUP_RETENTION_DAYS: backupConfig.retention.backup.alerts,
};
