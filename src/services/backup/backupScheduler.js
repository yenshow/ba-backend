/**
 * 備份排程器
 * 定時備份過期資料並刪除，依資料夾分類（environment_readings、alerts、people_counting、vehicle_access）
 */

const backupService = require("./backupService");
const backupConfig = require("./backupConfig");
const alertService = require("../alerts/alertService");
const peopleCountingSyncService = require("../systems/peopleCountingSyncService");
const vehicleAccessSyncService = require("../systems/vehicleAccessSyncService");
const environmentReadingsService = require("../systems/environmentReadingsService");
const environmentAggregationService = require("../systems/environmentAggregationService");
const { transformAlertsToReportFormat } = require("./alertsReportFormat");
const {
  transformPeopleCountingToReportFormat,
} = require("./peopleCountingReportFormat");
const {
  transformVehicleAccessToReportFormat,
} = require("./vehicleAccessReportFormat");
const {
  transformEnvironmentReadingsToReportFormat,
} = require("./environmentReadingsReportFormat");
const {
  transformEnvironmentReadingsAggregatedToReportFormat,
} = require("./environmentReadingsAggregatedReportFormat");

const RETENTION_DAYS = backupConfig.retention.databaseDays;
const FILE_RETENTION_DAYS = backupConfig.retention.backupFileDays;
const logger = require("../../utils/logger");

const backupLogger = logger.createLogger("backupScheduler");

/**
 * 執行完整備份流程（警報為狀態型：不因跨日自動結案；僅備份並刪除已解決且過保留期之資料）
 */
async function runBackup() {
  const beforeDate = new Date();
  beforeDate.setDate(beforeDate.getDate() - RETENTION_DAYS);

  const results = {
    environment_readings: null,
    environment_readings_aggregated: null,
    alerts: null,
    people_counting_logs: null,
    vehicle_passageway_logs: null,
    deletedFiles: 0,
  };

  try {
    // 彙總寫入：昨日 day、上月 month（每日備份時執行一次）
    try {
      await environmentAggregationService.computeAndSaveDayAndMonth();
    } catch (aggError) {
      backupLogger.warn("彙總寫入 day/month 略過", {
        error: aggError?.message || String(aggError),
        module: "backupScheduler",
      });
    }

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
      csvTransform: transformEnvironmentReadingsToReportFormat,
    });
    results.environment_readings = envResult;

    // environment_readings_aggregated（同一 beforeDate，先備份再刪除）
    const aggData = await environmentReadingsService.getAggregatedForBackup(beforeDate);
    const aggResult = await backupService.backupTable({
      tableName: "environment_readings_aggregated",
      data: aggData,
      deleteQuery: "DELETE FROM environment_readings_aggregated WHERE bucket_at < $1",
      deleteParams: [beforeDate],
      category: "environmentReadingsAggregated",
      deleteAfterBackup: true,
      mergeStrategy: "date",
      csvTransform: transformEnvironmentReadingsAggregatedToReportFormat,
    });
    results.environment_readings_aggregated = aggResult;

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
      backupLogger.warn("人流統計同步/備份略過", {
        error: pcError?.message || String(pcError),
        module: "backupScheduler",
      });
      results.people_counting_logs = { error: pcError.message };
    }

    // vehicle_passageway_logs：先同步再備份
    let vehicleResult = { count: 0, deletedCount: 0, message: "略過" };
    try {
      await vehicleAccessSyncService.syncYesterday();
      await vehicleAccessSyncService.syncDayAgo(RETENTION_DAYS + 1);

      const vehicleRows =
        await backupService.getVehiclePassagewayForBackup(beforeDate);

      const vehicleData = await backupService.backupTable({
        tableName: "vehicle_passageway_logs",
        data: vehicleRows,
        deleteQuery:
          "DELETE FROM vehicle_passageway_logs WHERE trigger_time < $1",
        deleteParams: [beforeDate],
        category: "vehicleAccess",
        deleteAfterBackup: true,
        mergeStrategy: "date",
        csvTransform: transformVehicleAccessToReportFormat,
      });
      vehicleResult = vehicleData;
      results.vehicle_passageway_logs = vehicleResult;
    } catch (vaError) {
      backupLogger.warn("車輛進出同步/備份略過", {
        error: vaError?.message || String(vaError),
        module: "backupScheduler",
      });
      results.vehicle_passageway_logs = { error: vaError.message };
    }

    // 刪除過期備份檔
    results.deletedFiles += await backupService.deleteOldBackups(
      "environmentReadings",
      FILE_RETENTION_DAYS,
    );
    results.deletedFiles += await backupService.deleteOldBackups(
      "environmentReadingsAggregated",
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
    results.deletedFiles += await backupService.deleteOldBackups(
      "vehicleAccess",
      FILE_RETENTION_DAYS,
    );

    const totalBacked =
      (envResult.count || 0) +
      (aggResult.count || 0) +
      (alertResult.count || 0) +
      (peopleResult.count || 0) +
      (vehicleResult.count || 0);
    const totalDeleted =
      (envResult.deletedCount || 0) +
      (aggResult.deletedCount || 0) +
      (alertResult.deletedCount || 0) +
      (peopleResult.deletedCount || 0) +
      (vehicleResult.deletedCount || 0);
    backupLogger.info("備份完成", {
      totalBacked,
      totalDeleted,
      deletedFiles: results.deletedFiles,
      module: "backupScheduler",
    });

    return results;
  } catch (error) {
    backupLogger.error("備份失敗", {
      error: error?.message || String(error),
      module: "backupScheduler",
    });
    throw error;
  }
}

/**
 * 啟動定時備份（伺服器啟動時呼叫）
 */
function startScheduler() {
  const interval = backupConfig.scheduler.interval;
  const timer = setInterval(() => {
    runBackup().catch((err) =>
      backupLogger.error("定時任務失敗", {
        error: err?.message || String(err),
        module: "backupScheduler",
      }),
    );
  }, interval);

  backupLogger.info("備份排程已啟動", {
    intervalHours: interval / 1000 / 60 / 60,
    module: "backupScheduler",
  });

  return {
    stop: () => {
      clearInterval(timer);
      backupLogger.info("備份排程已停止", { module: "backupScheduler" });
    },
    runNow: () => runBackup(),
  };
}

module.exports = {
  runBackup,
  startScheduler,
};
