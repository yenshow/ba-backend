/**
 * 備份排程：歸檔過期 DB 列為 CSV，驗證通過後刪除；清理過期歸檔檔
 */

const { getModuleDisplayNameByCode } = require("../../access/catalog");
const backupService = require("./backupService");
const { getBackupConfig } = require("./backupConfig");
const alertService = require("../alerts/alertService");
const peopleCountingSyncService = require("../peopleCounting/peopleCountingSyncService");
const vehicleAccessSyncService = require("../vehicleAccess/vehicleAccessSyncService");
const environmentReadingsService = require("../environment/environmentReadingsService");
const environmentAggregationService = require("../environment/environmentAggregationService");
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
  transformIsapiAccessEventsToReportFormat,
  transformIsapiPeopleCountingToReportFormat,
} = require("./isapiEventsReportFormat");
const logger = require("../../utils/logger");
const {
  peopleCounting: yscpPeopleFeature,
  vehicleAccess: yscpVehicleFeature,
} = require("../../utils/yscpSystemFeature");

const backupLogger = logger.createLogger("backupScheduler");

let isBackupRunning = false;

function cutoffBeforeDate() {
  const cutoffDays = getBackupConfig().retention.databaseDays;
  const before = new Date();
  before.setDate(before.getDate() - cutoffDays);
  return before;
}

async function runOptionalSync(label, syncFns) {
  for (const fn of syncFns) {
    try {
      await fn();
    } catch (error) {
      backupLogger.warn(`${label}同步略過（仍嘗試備份／刪除既有 DB 資料）`, {
        error: error?.message || String(error),
        module: "backupScheduler",
      });
    }
  }
}

async function runBackupJob(label, job) {
  try {
    return await job();
  } catch (error) {
    backupLogger.error(`${label}備份失敗（DB 可能未刪除過期資料）`, {
      error: error?.message || String(error),
      module: "backupScheduler",
    });
    return { error: error.message };
  }
}

function sumCounts(...results) {
  return results.reduce(
    (acc, r) => ({
      backed: acc.backed + (r?.count || 0),
      deleted: acc.deleted + (r?.deletedCount || 0),
    }),
    { backed: 0, deleted: 0 },
  );
}

async function backupIsapiEventTable(label, beforeDate, options) {
  const {
    tableName,
    fetchRows,
    csvTransform,
    category = "peopleCounting",
  } = options;
  return runBackupJob(label, async () =>
    backupService.backupTable({
      tableName,
      data: await fetchRows(beforeDate),
      deleteQuery: `DELETE FROM ${tableName} WHERE event_time < $1`,
      deleteParams: [beforeDate],
      category,
      deleteAfterBackup: true,
      csvTransform,
    }),
  );
}

async function runBackup() {
  const beforeDate = cutoffBeforeDate();

  try {
    try {
      await environmentAggregationService.computeAndSaveDayAndMonth();
    } catch (error) {
      backupLogger.warn("彙總寫入 day/month 略過", {
        error: error?.message || String(error),
        module: "backupScheduler",
      });
    }

    const envResult = await backupService.backupTable({
      tableName: "environment_readings",
      data: await environmentReadingsService.getReadingsForBackup(beforeDate),
      deleteQuery: "DELETE FROM environment_readings WHERE recorded_at < $1",
      deleteParams: [beforeDate],
      category: "environmentReadings",
      deleteAfterBackup: true,
      csvTransform: transformEnvironmentReadingsToReportFormat,
    });

    const alertResult = await backupService.backupTable({
      tableName: "alerts",
      data: await alertService.getResolvedAlertsForBackup(beforeDate),
      deleteQuery: `DELETE FROM alerts WHERE status = 'resolved' AND updated_at < $1`,
      deleteParams: [beforeDate],
      category: "alerts",
      deleteAfterBackup: true,
      csvTransform: transformAlertsToReportFormat,
    });

    const peopleModuleLabel =
      getModuleDisplayNameByCode("system.people_counting") ?? "門禁管理";

    let peopleYscpResult = { skipped: true };
    if (yscpPeopleFeature.isEnabled()) {
      await runOptionalSync(`${peopleModuleLabel}（YSCP）`, [
        () => peopleCountingSyncService.syncYesterday(),
        () =>
          peopleCountingSyncService.syncDayAgo(
            getBackupConfig().retention.databaseDays + 1,
          ),
      ]);
      peopleYscpResult = await runBackupJob(`${peopleModuleLabel}（YSCP）`, async () => {
        const peopleRows =
          await backupService.getPeopleCountingForBackup(beforeDate);
        const physicalIds = [
          ...new Set(peopleRows.map((r) => r.physical_id).filter(Boolean)),
        ];
        const [doorNameMap, directionMap] = await Promise.all([
          peopleCountingSyncService.getDoorNamesByPhysicalIds(physicalIds),
          peopleCountingSyncService.getPhysicalIdToDirectionMap(),
        ]);
        return backupService.backupTable({
          tableName: "people_counting_logs",
          data: peopleRows,
          deleteQuery:
            "DELETE FROM people_counting_logs WHERE swip_card_rev_time < $1",
          deleteParams: [beforeDate],
          category: "peopleCounting",
          deleteAfterBackup: true,
          csvTransform: (rows) =>
            transformPeopleCountingToReportFormat(
              rows,
              doorNameMap,
              directionMap,
            ),
        });
      });
    }

    const peopleAccessIsapiResult = await backupIsapiEventTable(
      `${peopleModuleLabel}門禁（ISAPI）`,
      beforeDate,
      {
        tableName: "isapi_access_events",
        fetchRows: backupService.getIsapiAccessEventsForBackup,
        csvTransform: transformIsapiAccessEventsToReportFormat,
      },
    );

    const peopleCameraIsapiResult = await backupIsapiEventTable(
      `${peopleModuleLabel}攝影機（ISAPI）`,
      beforeDate,
      {
        tableName: "isapi_people_counting_events",
        fetchRows: backupService.getIsapiPeopleCountingEventsForBackup,
        csvTransform: transformIsapiPeopleCountingToReportFormat,
      },
    );

    let vehicleYscpResult = { skipped: true };
    if (yscpVehicleFeature.isEnabled()) {
      await runOptionalSync("車輛進出（YSCP）", [
        () => vehicleAccessSyncService.syncYesterday(),
        () =>
          vehicleAccessSyncService.syncDayAgo(
            getBackupConfig().retention.databaseDays + 1,
          ),
      ]);
      vehicleYscpResult = await runBackupJob("車輛進出（YSCP）", async () =>
        backupService.backupTable({
          tableName: "vehicle_passageway_logs",
          data: await backupService.getVehiclePassagewayForBackup(
            beforeDate,
            "yscp",
          ),
          deleteQuery: `DELETE FROM vehicle_passageway_logs
            WHERE trigger_time < $1 AND COALESCE(data_source, 'yscp') = 'yscp'`,
          deleteParams: [beforeDate],
          category: "vehicleAccess",
          deleteAfterBackup: true,
          csvTransform: transformVehicleAccessToReportFormat,
        }),
      );
    }

    const vehicleIsapiResult = await runBackupJob(
      "車輛進出（ISAPI）",
      async () =>
        backupService.backupTable({
          tableName: "vehicle_passageway_logs_isapi",
          data: await backupService.getVehiclePassagewayForBackup(
            beforeDate,
            "isapi_camera",
          ),
          deleteQuery: `DELETE FROM vehicle_passageway_logs
            WHERE trigger_time < $1 AND data_source = 'isapi_camera'`,
          deleteParams: [beforeDate],
          category: "vehicleAccess",
          deleteAfterBackup: true,
          csvTransform: transformVehicleAccessToReportFormat,
        }),
    );

    const deletedFiles = await backupService.purgeOldArchiveFiles(
      getBackupConfig().retention.backupFileDays,
    );

    const { backed, deleted } = sumCounts(
      envResult,
      alertResult,
      peopleYscpResult,
      peopleAccessIsapiResult,
      peopleCameraIsapiResult,
      vehicleYscpResult,
      vehicleIsapiResult,
    );

    const results = {
      environment_readings: envResult,
      alerts: alertResult,
      people_counting_logs: peopleYscpResult,
      isapi_access_events: peopleAccessIsapiResult,
      isapi_people_counting_events: peopleCameraIsapiResult,
      vehicle_passageway_logs: vehicleYscpResult,
      vehicle_passageway_logs_isapi: vehicleIsapiResult,
      deletedFiles,
    };

    backupLogger.info("備份完成", {
      totalBacked: backed,
      totalDeleted: deleted,
      deletedFiles,
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

async function runBackupOnce() {
  if (isBackupRunning) {
    backupLogger.warn("備份執行中，略過重複觸發", {
      module: "backupScheduler",
    });
    return null;
  }

  isBackupRunning = true;
  try {
    return await runBackup();
  } finally {
    isBackupRunning = false;
  }
}

function scheduleBackupRun(onError) {
  runBackupOnce().catch(onError);
}

function startScheduler() {
  const { scheduler, retention } = getBackupConfig();
  const interval = scheduler.interval;
  const onError = (err) =>
    backupLogger.error("備份任務失敗", {
      error: err?.message || String(err),
      module: "backupScheduler",
    });

  const timer = setInterval(() => scheduleBackupRun(onError), interval);
  setImmediate(() => scheduleBackupRun(onError));

  backupLogger.info("備份排程已啟動", {
    intervalHours: interval / 1000 / 60 / 60,
    databaseCutoffDays: retention.databaseDays,
    archiveFileRetentionDays: retention.backupFileDays,
    module: "backupScheduler",
  });

  return {
    stop: () => {
      clearInterval(timer);
      backupLogger.info("備份排程已停止", { module: "backupScheduler" });
    },
    runNow: () => runBackupOnce(),
  };
}

module.exports = {
  runBackup,
  runBackupOnce,
  startScheduler,
};
