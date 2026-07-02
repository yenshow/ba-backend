/**
 * 備份排程：雙層保留、按日 CSV、每日定時觸發
 */

const { DateTime } = require("luxon");
const { getModuleDisplayNameByCode } = require("../../access/catalog");
const backupService = require("./backupService");
const { getBackupConfig } = require("./backupConfig");
const alertService = require("../alerts/alertService");
const peopleCountingSyncService = require("../peopleCounting/peopleCountingSyncService");
const vehicleAccessSyncService = require("../vehicleAccess/vehicleAccessSyncService");
const environmentReadingsService = require("../environment/environmentReadingsService");
const environmentAggregationService = require("../environment/environmentAggregationService");
const runtimeConfigService = require("../platform/runtimeConfigService");
const effectiveFeaturesCache = require("../license/effectiveFeaturesCache");
const db = require("../../database/db");
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
const {
  transformLadderSdkEventsToReportFormat,
} = require("./ladderSdkEventsReportFormat");
const logger = require("../../utils/logger");
const {
  peopleCounting: yscpPeopleFeature,
  vehicleAccess: yscpVehicleFeature,
} = require("../../utils/yscpSystemFeature");

const backupLogger = logger.createLogger("backupScheduler");

let isBackupRunning = false;
let backupTimer = null;

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

const buildDeleteSql = (table, dateCol, extraWhere = "") => ({
  buildDeleteDaySql: (start, end, deleteBefore) => ({
    sql: `DELETE FROM ${table} WHERE ${dateCol} >= $1 AND ${dateCol} < $2 AND ${dateCol} < $3 ${extraWhere}`,
    params: [start, end, deleteBefore],
  }),
});

async function selectVehiclePictures(start, end, dataSource) {
  const rows = await db.query(
    `SELECT picture_path FROM vehicle_passageway_logs
     WHERE trigger_time >= $1 AND trigger_time < $2
       AND data_source = $3 AND picture_path IS NOT NULL`,
    [start, end, dataSource],
  );
  return (rows || []).map((r) => r.picture_path).filter(Boolean);
}

async function selectAccessPictures(start, end) {
  const rows = await db.query(
    `SELECT picture_path FROM isapi_access_events
     WHERE event_time >= $1 AND event_time < $2 AND picture_path IS NOT NULL`,
    [start, end],
  );
  return (rows || []).map((r) => r.picture_path).filter(Boolean);
}

async function runBackup() {
  const { archiveBeforeDate, deleteBeforeDate } =
    backupService.getRetentionContext();
  const onlineDays = getBackupConfig().retention.onlineRetentionDays;

  try {
    try {
      await environmentAggregationService.computeAndSaveDayAndMonth();
    } catch (error) {
      backupLogger.warn("彙總寫入 day/month 略過", {
        error: error?.message || String(error),
        module: "backupScheduler",
      });
    }

    const envDelete = buildDeleteSql("environment_readings", "recorded_at");
    const envResult = await backupService.backupTableDual({
      tableName: "environment_readings",
      rows: await environmentReadingsService.getReadingsForBackup(
        archiveBeforeDate,
      ),
      dateField: "recorded_at",
      category: "environmentReadings",
      csvTransform: transformEnvironmentReadingsToReportFormat,
      selectColdTimestampsSql: `SELECT recorded_at FROM environment_readings WHERE recorded_at < $1`,
      selectColdParams: [deleteBeforeDate],
      ...envDelete,
    });

    const alertDelete = buildDeleteSql(
      "alerts",
      "updated_at",
      "AND status = 'resolved'",
    );
    const alertResult = await backupService.backupTableDual({
      tableName: "alerts",
      rows: await alertService.getResolvedAlertsForBackup(archiveBeforeDate),
      dateField: "updated_at",
      category: "alerts",
      csvTransform: transformAlertsToReportFormat,
      selectColdTimestampsSql: `SELECT updated_at FROM alerts WHERE status = 'resolved' AND updated_at < $1`,
      selectColdParams: [deleteBeforeDate],
      ...alertDelete,
    });

    const peopleModuleLabel =
      getModuleDisplayNameByCode("system.people_counting") ?? "門禁管理";

    let peopleYscpResult = { skipped: true };
    if (yscpPeopleFeature.isEnabled()) {
      await runOptionalSync(`${peopleModuleLabel}（YSCP）`, [
        () => peopleCountingSyncService.syncYesterday(),
        () => peopleCountingSyncService.syncDayAgo(onlineDays + 1),
      ]);
      peopleYscpResult = await runBackupJob(`${peopleModuleLabel}（YSCP）`, async () => {
        const peopleRows =
          await backupService.getPeopleCountingForBackup(archiveBeforeDate);
        const physicalIds = [
          ...new Set(peopleRows.map((r) => r.physical_id).filter(Boolean)),
        ];
        const [doorNameMap, directionMap] = await Promise.all([
          peopleCountingSyncService.getDoorNamesByPhysicalIds(physicalIds),
          peopleCountingSyncService.getPhysicalIdToDirectionMap(),
        ]);
        const peopleDelete = buildDeleteSql(
          "people_counting_logs",
          "swip_card_rev_time",
        );
        return backupService.backupTableDual({
          tableName: "people_counting_logs",
          rows: peopleRows,
          dateField: "swip_card_rev_time",
          category: "peopleCounting",
          csvTransform: (rows) =>
            transformPeopleCountingToReportFormat(
              rows,
              doorNameMap,
              directionMap,
            ),
          selectColdTimestampsSql: `SELECT swip_card_rev_time FROM people_counting_logs WHERE swip_card_rev_time < $1`,
          selectColdParams: [deleteBeforeDate],
          ...peopleDelete,
        });
      });
    }

    const accessDelete = buildDeleteSql("isapi_access_events", "event_time");
    const peopleAccessIsapiResult = await runBackupJob(
      `${peopleModuleLabel}門禁（ISAPI）`,
      async () =>
        backupService.backupTableDual({
          tableName: "isapi_access_events",
          rows: await backupService.getIsapiAccessEventsForBackup(
            archiveBeforeDate,
          ),
          dateField: "event_time",
          category: "peopleCounting",
          csvTransform: transformIsapiAccessEventsToReportFormat,
          attachmentSubdir: "access-events",
          selectColdTimestampsSql: `SELECT event_time FROM isapi_access_events WHERE event_time < $1`,
          selectColdParams: [deleteBeforeDate],
          selectPicturesForDay: (start, end) => selectAccessPictures(start, end),
          ...accessDelete,
        }),
    );

    const cameraDelete = buildDeleteSql(
      "isapi_people_counting_events",
      "event_time",
    );
    const peopleCameraIsapiResult = await runBackupJob(
      `${peopleModuleLabel}攝影機（ISAPI）`,
      async () =>
        backupService.backupTableDual({
          tableName: "isapi_people_counting_events",
          rows: await backupService.getIsapiPeopleCountingEventsForBackup(
            archiveBeforeDate,
          ),
          dateField: "event_time",
          category: "peopleCounting",
          csvTransform: transformIsapiPeopleCountingToReportFormat,
          selectColdTimestampsSql: `SELECT event_time FROM isapi_people_counting_events WHERE event_time < $1`,
          selectColdParams: [deleteBeforeDate],
          ...cameraDelete,
        }),
    );

    let vehicleYscpResult = { skipped: true };
    if (yscpVehicleFeature.isEnabled()) {
      await runOptionalSync("車輛進出（YSCP）", [
        () => vehicleAccessSyncService.syncYesterday(),
        () => vehicleAccessSyncService.syncDayAgo(onlineDays + 1),
      ]);
      const vehicleYscpDelete = buildDeleteSql(
        "vehicle_passageway_logs",
        "trigger_time",
        "AND COALESCE(data_source, 'yscp') = 'yscp'",
      );
      vehicleYscpResult = await runBackupJob("車輛進出（YSCP）", async () =>
        backupService.backupTableDual({
          tableName: "vehicle_passageway_logs",
          rows: await backupService.getVehiclePassagewayForBackup(
            archiveBeforeDate,
            "yscp",
          ),
          dateField: "trigger_time",
          category: "vehicleAccess",
          csvTransform: transformVehicleAccessToReportFormat,
          selectColdTimestampsSql: `SELECT trigger_time FROM vehicle_passageway_logs WHERE trigger_time < $1 AND COALESCE(data_source, 'yscp') = 'yscp'`,
          selectColdParams: [deleteBeforeDate],
          ...vehicleYscpDelete,
        }),
      );
    }

    const vehicleIsapiDelete = buildDeleteSql(
      "vehicle_passageway_logs",
      "trigger_time",
      "AND data_source = 'isapi_camera'",
    );
    const vehicleIsapiResult = await runBackupJob("車輛進出（ISAPI）", async () =>
      backupService.backupTableDual({
        tableName: "vehicle_passageway_logs_isapi",
        rows: await backupService.getVehiclePassagewayForBackup(
          archiveBeforeDate,
          "isapi_camera",
        ),
        dateField: "trigger_time",
        category: "vehicleAccess",
        csvTransform: transformVehicleAccessToReportFormat,
        attachmentSubdir: "vehicle-events",
        selectColdTimestampsSql: `SELECT trigger_time FROM vehicle_passageway_logs WHERE trigger_time < $1 AND data_source = 'isapi_camera'`,
        selectColdParams: [deleteBeforeDate],
        selectPicturesForDay: (start, end) =>
          selectVehiclePictures(start, end, "isapi_camera"),
        ...vehicleIsapiDelete,
      }),
    );

    let ladderResult = { skipped: true };
    if (effectiveFeaturesCache.hasCachedLicensedFeature("elevator")) {
      const ladderDelete = buildDeleteSql("ladder_sdk_events", "event_time");
      ladderResult = await runBackupJob("梯控（SDK）", async () =>
        backupService.backupTableDual({
          tableName: "ladder_sdk_events",
          rows: await backupService.getLadderSdkEventsForBackup(
            archiveBeforeDate,
          ),
          dateField: "event_time",
          category: "elevator",
          csvTransform: transformLadderSdkEventsToReportFormat,
          selectColdTimestampsSql: `SELECT event_time FROM ladder_sdk_events WHERE event_time < $1`,
          selectColdParams: [deleteBeforeDate],
          ...ladderDelete,
        }),
      );
    }

    const { backed, deleted } = sumCounts(
      envResult,
      alertResult,
      peopleYscpResult,
      peopleAccessIsapiResult,
      peopleCameraIsapiResult,
      vehicleYscpResult,
      vehicleIsapiResult,
      ladderResult,
    );

    const results = {
      environment_readings: envResult,
      alerts: alertResult,
      people_counting_logs: peopleYscpResult,
      isapi_access_events: peopleAccessIsapiResult,
      isapi_people_counting_events: peopleCameraIsapiResult,
      vehicle_passageway_logs: vehicleYscpResult,
      vehicle_passageway_logs_isapi: vehicleIsapiResult,
      ladder_sdk_events: ladderResult,
    };

    const noopBackup = backed === 0 && deleted === 0;
    const backupMeta = {
      totalBacked: backed,
      totalDeleted: deleted,
      module: "backupScheduler",
    };
    if (noopBackup) {
      backupLogger.debug("備份完成（無資料異動）", backupMeta);
    } else {
      backupLogger.info("備份完成", backupMeta);
    }

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

function scheduleNextBackup(onError) {
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }

  const alerts = runtimeConfigService.getAlerts();
  const { scheduler } = getBackupConfig();
  const tz = alerts.dailyRolloverTimezone;
  const h = scheduler.dailyLocalHour;
  const m = scheduler.dailyLocalMinute;

  const now = DateTime.now().setZone(tz);
  let next = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (next <= now) {
    next = next.plus({ days: 1 });
  }
  const ms = Math.max(1000, Math.ceil(next.diff(now).as("milliseconds")));

  backupTimer = setTimeout(() => {
    backupTimer = null;
    runBackupOnce().catch(onError);
    scheduleNextBackup(onError);
  }, ms);
}

function startScheduler() {
  const { retention, scheduler } = getBackupConfig();
  const alerts = runtimeConfigService.getAlerts();
  const onError = (err) =>
    backupLogger.error("備份任務失敗", {
      error: err?.message || String(err),
      module: "backupScheduler",
    });

  scheduleNextBackup(onError);
  setImmediate(() => runBackupOnce().catch(onError));

  backupLogger.info("備份排程已啟動", {
    dailyLocalTime: `${String(scheduler.dailyLocalHour).padStart(2, "0")}:${String(scheduler.dailyLocalMinute).padStart(2, "0")}`,
    timezone: alerts.dailyRolloverTimezone,
    archiveAfterDays: retention.archiveAfterDays,
    onlineRetentionDays: retention.onlineRetentionDays,
    module: "backupScheduler",
  });

  return {
    stop: () => {
      if (backupTimer) {
        clearTimeout(backupTimer);
        backupTimer = null;
      }
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
