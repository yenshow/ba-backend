/**
 * 備份排程器
 * 定時備份過期資料並刪除，依資料夾分類（environment_readings、alerts、people_counting）
 */

const backupService = require("./backupService");
const backupConfig = require("./backupConfig");
const alertService = require("../alerts/alertService");
const peopleCountingSyncService = require("../systems/peopleCountingSyncService");
const environmentReadingsService = require("../systems/environmentReadingsService");
const { transformAlertsToReportFormat } = require("./alertsReportFormat");
const {
  transformPeopleCountingToReportFormat,
} = require("./peopleCountingReportFormat");
const {
  transformEnvironmentReadingsToReportFormat,
} = require("./environmentReadingsReportFormat");

const RETENTION_DAYS = backupConfig.retention.databaseDays;
const FILE_RETENTION_DAYS = backupConfig.retention.backupFileDays;

/**
 * 執行完整備份流程（每次備份前先執行每日結案：昨日及更早的 active 警報標記為已解決）
 */
async function runBackup() {
  const beforeDate = new Date();
  beforeDate.setDate(beforeDate.getDate() - RETENTION_DAYS);

  const results = {
    environment_readings: null,
    alerts: null,
    people_counting_logs: null,
    deletedFiles: 0,
    staleAlertsResolved: 0,
  };

  try {
    results.staleAlertsResolved = await alertService.resolveStaleActiveAlerts();

    // environment_readings
    const envData =
      await environmentReadingsService.getReadingsForBackup(beforeDate);
    const envResult = await backupService.backupTable({
      tableName: "environment_readings",
      data: envData,
      deleteQuery: "DELETE FROM environment_readings WHERE recorded_at < $1",
      deleteParams: [beforeDate],
      category: "environmentReadings",
      deleteAfterBackup: true,
      mergeStrategy: "date",
      compress: backupConfig.compression.enabled,
      csvTransform: transformEnvironmentReadingsToReportFormat,
    });
    results.environment_readings = envResult;

    // alerts
    const enrichedAlerts =
      await alertService.getResolvedAlertsForBackup(beforeDate);
    const alertResult = await backupService.backupTable({
      tableName: "alerts",
      data: enrichedAlerts,
      deleteQuery: `DELETE FROM alerts WHERE status = 'resolved' AND updated_at < $1`,
      deleteParams: [beforeDate],
      category: "alerts",
      deleteAfterBackup: true,
      mergeStrategy: "date",
      compress: backupConfig.compression.enabled,
      csvTransform: transformAlertsToReportFormat,
    });
    results.alerts = alertResult;

    // people_counting_logs：先同步再備份
    let peopleResult = { count: 0, deletedCount: 0, message: "略過" };
    try {
      await peopleCountingSyncService.syncYesterday();
      await peopleCountingSyncService.syncDayAgo(RETENTION_DAYS + 1);

      const peopleRows =
        await backupService.getPeopleCountingForBackup(beforeDate);
      const physicalIds = [
        ...new Set(peopleRows.map((r) => r.physical_id).filter(Boolean)),
      ];
      const [doorNameMap, directionMap] = await Promise.all([
        peopleCountingSyncService.getDoorNamesByPhysicalIds(physicalIds),
        peopleCountingSyncService.getPhysicalIdToDirectionMap(),
      ]);

      const peopleData = await backupService.backupTable({
        tableName: "people_counting_logs",
        data: peopleRows,
        deleteQuery:
          "DELETE FROM people_counting_logs WHERE swip_card_rev_time < $1",
        deleteParams: [beforeDate],
        category: "peopleCounting",
        deleteAfterBackup: true,
        mergeStrategy: "date",
        compress: backupConfig.compression.enabled,
        csvTransform: (rows) =>
          transformPeopleCountingToReportFormat(
            rows,
            doorNameMap,
            directionMap,
          ),
      });
      peopleResult = peopleData;
      results.people_counting_logs = peopleResult;
    } catch (pcError) {
      console.warn("[backup] 人流統計同步/備份略過:", pcError.message);
      results.people_counting_logs = { error: pcError.message };
    }

    // 刪除過期備份檔
    results.deletedFiles += await backupService.deleteOldBackups(
      "environmentReadings",
      FILE_RETENTION_DAYS,
    );
    results.deletedFiles += await backupService.deleteOldBackups(
      "alerts",
      FILE_RETENTION_DAYS,
    );
    results.deletedFiles += await backupService.deleteOldBackups(
      "peopleCounting",
      FILE_RETENTION_DAYS,
    );

    const totalBacked =
      (envResult.count || 0) +
      (alertResult.count || 0) +
      (peopleResult.count || 0);
    const totalDeleted =
      (envResult.deletedCount || 0) +
      (alertResult.deletedCount || 0) +
      (peopleResult.deletedCount || 0);
    console.log(
      `[backup] 完成: 備份 ${totalBacked} 筆, 刪除 DB ${totalDeleted} 筆, 刪除舊檔 ${results.deletedFiles} 個`,
    );

    return results;
  } catch (error) {
    console.error("[backup] 備份失敗:", error);
    throw error;
  }
}

/**
 * 啟動定時備份（伺服器啟動時呼叫）
 */
function startScheduler() {
  if (!backupConfig.scheduler.enabled) {
    return {
      stop: () => {},
      runNow: () => Promise.resolve({ message: "備份排程未啟用" }),
    };
  }

  const interval = backupConfig.scheduler.interval;
  const timer = setInterval(() => {
    runBackup().catch((err) => console.error("[backup] 定時任務失敗:", err));
  }, interval);

  console.log(`[backup] 已啟動，每 ${interval / 1000 / 60 / 60} 小時執行一次`);

  return {
    stop: () => {
      clearInterval(timer);
      console.log("[backup] 已停止");
    },
    runNow: () => runBackup(),
  };
}

module.exports = {
  runBackup,
  startScheduler,
};
