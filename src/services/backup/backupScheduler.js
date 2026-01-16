/**
 * 備份排程器
 * 管理定時備份任務
 */

const backupService = require("./backupService");
const backupConfig = require("./backupConfig");

/**
 * 執行警報自動清理備份
 * @returns {Promise<Object>} 執行結果
 */
async function runAlertsCleanup() {
  try {
    console.log("[backupScheduler] 開始執行警報清理備份...");

    const retentionDays = backupConfig.retention.database.alerts;
    const beforeDate = new Date();
    beforeDate.setDate(beforeDate.getDate() - retentionDays);

    // 備份並刪除舊警報
    const result = await backupService.backupTable({
      tableName: "alerts",
      query: `SELECT * FROM alerts 
              WHERE status = 'resolved' 
              AND resolved_at < $1 
              ORDER BY resolved_at ASC`,
      params: [beforeDate],
      deleteQuery: `DELETE FROM alerts 
                    WHERE status = 'resolved' 
                    AND resolved_at < $1`,
      deleteParams: [beforeDate],
      category: "alerts",
      formats: backupConfig.formats.alerts,
      deleteAfterBackup: true,
      mergeStrategy: "daily", // 同一天合併
      compress: backupConfig.compression.enabled,
    });

    // 刪除超過保留期的備份檔案
    const deletedBackups = await backupService.deleteOldBackups(
      "alerts",
      backupConfig.retention.backup.alerts
    );

    console.log(
      `[backupScheduler] 警報清理完成: 備份 ${result.count} 筆警報, ` +
      `刪除 ${result.deletedCount} 筆資料庫記錄, ` +
      `刪除 ${deletedBackups} 個舊備份檔案`
    );

    return {
      ...result,
      deletedBackups,
    };
  } catch (error) {
    console.error("[backupScheduler] 警報清理失敗:", error);
    throw error;
  }
}

/**
 * 啟動定時備份任務
 */
function startScheduler() {
  const schedulerConfig = backupConfig.scheduler;

  // 啟動警報自動清理
  if (schedulerConfig.alerts.enabled) {
    const interval = schedulerConfig.alerts.interval;

    // 設定定時任務
    const timer = setInterval(() => {
      runAlertsCleanup().catch((error) => {
        console.error("[backupScheduler] 定時清理任務失敗:", error);
      });
    }, interval);

    console.log(
      `[backupScheduler] 已啟動警報自動清理任務，每 ${interval / 1000 / 60 / 60} 小時執行一次`
    );

    // 返回清理函數
    return {
      stop: () => {
        clearInterval(timer);
        console.log("[backupScheduler] 已停止定時備份任務");
      },
      runNow: () => runAlertsCleanup(),
    };
  }

  return {
    stop: () => {},
    runNow: () => Promise.resolve({ message: "排程器未啟用" }),
  };
}

module.exports = {
  startScheduler,
  runAlertsCleanup,
};

