/**
 * 備份排程：雙層保留、按日歸檔（CSV／xlsx）、每日定時觸發
 */

const { createDailyLocalScheduler } = require("../../utils/dailyLocalScheduler");
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
const {
  transformAlertsToReportFormat,
  transformEnvironmentReadingsToReportFormat,
  transformEnergyReadingsToReportFormat,
  transformOperationalEventsToReportFormat,
  transformLadderSdkEventsToReportFormat,
} = require("./simpleReportFormats");
const {
  transformPeopleCountingToReportFormat,
  collectAccessEmployeeNos,
  transformIsapiAccessEventsToReportFormat,
  transformIsapiFaceContrastEventsToReportFormat,
  transformIsapiPeopleCountingToReportFormat,
} = require("./peopleCountingReportFormat");
const {
  transformVehicleAccessToReportFormat,
} = require("./vehicleAccessReportFormat");
const {
  loadPeopleCountingBackupContext,
  loadPersonsByEmployeeNos,
} = require("./loadPeopleCountingBackupContext");
const {
  loadNormalizedStatLabelsForSystemType,
} = require("../entryExit/statLabels");
const energyReadingsService = require("../energy/energyReadingsService");
const logger = require("../../utils/logger");
const {
  peopleCounting: yscpPeopleFeature,
  vehicleAccess: yscpVehicleFeature,
} = require("../../utils/yscpSystemFeature");

const backupLogger = logger.createLogger("backupScheduler");

let isBackupRunning = false;
let schedulerHandle = null;

async function runOptionalSync(label, syncFns) {
  for (const fn of syncFns) {
    try {
      await fn();
    } catch (error) {
      backupLogger.warn(`${label}同步略過，繼續歸檔`, {
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
    backupLogger.error(`${label}歸檔失敗`, {
      error: error?.message || String(error),
      module: "backupScheduler",
    });
    return { error: error.message };
  }
}

async function runBackup() {
  const { archiveBeforeDate, archiveStartDate } = backupService.getRetentionContext();
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

    const envResult = await backupService.archiveTableByDay({
      tableName: "environment_readings",
      rows: await environmentReadingsService.getReadingsForBackup(
        archiveBeforeDate, archiveStartDate,
      ),
      dateField: "recorded_at",
      category: "environmentReadings",
      csvTransform: transformEnvironmentReadingsToReportFormat,
    });

    const alertResult = await backupService.archiveTableByDay({
      tableName: "alerts",
      rows: await alertService.getResolvedAlertsForBackup(archiveBeforeDate, archiveStartDate),
      dateField: "updated_at",
      category: "alerts",
      csvTransform: transformAlertsToReportFormat,
    });

    const peopleModuleLabel =
      getModuleDisplayNameByCode("system.people_counting") ?? "門禁管理";

    const peopleStatLabelsList =
      await loadNormalizedStatLabelsForSystemType("people_counting");
    const peopleReportOpts = { statLabelsList: peopleStatLabelsList };

    let peopleYscpResult = { skipped: true };
    if (yscpPeopleFeature.isEnabled()) {
      await runOptionalSync(`${peopleModuleLabel}（YSCP）`, [
        () => peopleCountingSyncService.syncYesterday(),
        () => peopleCountingSyncService.syncDayAgo(onlineDays + 1),
      ]);
      peopleYscpResult = await runBackupJob(`${peopleModuleLabel}（YSCP）`, async () => {
        const peopleRows =
          await backupService.getPeopleCountingForBackup(archiveBeforeDate, archiveStartDate);
        const physicalIds = [
          ...new Set(peopleRows.map((r) => r.physical_id).filter(Boolean)),
        ];
        const [doorNameMap, directionMap] = await Promise.all([
          peopleCountingSyncService.getDoorNamesByPhysicalIds(physicalIds),
          peopleCountingSyncService.getPhysicalIdToDirectionMap(),
        ]);

        return backupService.archiveTableByDay({
          tableName: "people_counting_logs",
          rows: peopleRows,
          dateField: "swip_card_rev_time",
          category: "peopleCounting",
          csvTransform: (rows) =>
            transformPeopleCountingToReportFormat(
              rows,
              doorNameMap,
              directionMap,
              peopleReportOpts,
            ),
        });
      });
    }

    const peopleCountingCtx = await loadPeopleCountingBackupContext();

    const peopleAccessIsapiResult = await runBackupJob(
      `${peopleModuleLabel}門禁（ISAPI）`,
      async () => {
        const accessRows =
          await backupService.getIsapiAccessEventsForBackup(archiveBeforeDate, archiveStartDate);
        const personByEmployeeNo = await loadPersonsByEmployeeNos(
          collectAccessEmployeeNos(accessRows),
        );
        return backupService.archiveTableByDay({
          tableName: "isapi_access_events",
          rows: accessRows,
          dateField: "event_time",
          category: "peopleCounting",
          csvTransform: (dayRows) =>
            transformIsapiAccessEventsToReportFormat(dayRows, {
              accessByDeviceId: peopleCountingCtx.accessByDeviceId,
              personByEmployeeNo,
              ...peopleReportOpts,
            }),
          attachmentSubdir: "people_counting/attachments",
          attachmentNamePrefix: "access_",
        });
      },
    );

    const peopleCameraIsapiResult = await runBackupJob(
      `${peopleModuleLabel}攝影機（ISAPI）`,
      async () =>
        backupService.archiveTableByDay({
          tableName: "isapi_people_counting_events",
          rows: await backupService.getIsapiPeopleCountingEventsForBackup(
            archiveBeforeDate, archiveStartDate,
          ),
          dateField: "event_time",
          category: "peopleCounting",
          csvTransform: (dayRows) =>
            transformIsapiPeopleCountingToReportFormat(
              dayRows,
              peopleReportOpts,
            ),
        }),
    );

    const peopleFaceContrastIsapiResult = await runBackupJob(
      `${peopleModuleLabel}人臉比對（ISAPI）`,
      async () => {
        const faceRows =
          await backupService.getIsapiFaceContrastEventsForBackup(
            archiveBeforeDate, archiveStartDate,
          );
        const employeeNos = (faceRows || [])
          .map((r) =>
            r.employee_no != null ? String(r.employee_no).trim() : "",
          )
          .filter(Boolean);
        const personByEmployeeNo =
          await loadPersonsByEmployeeNos(employeeNos);
        return backupService.archiveTableByDay({
          tableName: "isapi_face_contrast_events",
          rows: faceRows,
          dateField: "event_time",
          category: "peopleCounting",
          csvTransform: (dayRows) =>
            transformIsapiFaceContrastEventsToReportFormat(dayRows, {
              faceByDeviceId: peopleCountingCtx.faceByDeviceId,
              personByEmployeeNo,
              ...peopleReportOpts,
            }),
          attachmentSubdir: "people_counting/attachments",
          attachmentNamePrefix: "face_",
        });
      },
    );

    const vehicleStatLabelsList =
      await loadNormalizedStatLabelsForSystemType("vehicle_access");
    const vehicleReportOpts = { statLabelsList: vehicleStatLabelsList };

    let vehicleYscpResult = { skipped: true };
    if (yscpVehicleFeature.isEnabled()) {
      await runOptionalSync("車輛進出（YSCP）", [
        () => vehicleAccessSyncService.syncYesterday(),
        () => vehicleAccessSyncService.syncDayAgo(onlineDays + 1),
      ]);

      vehicleYscpResult = await runBackupJob("車輛進出（YSCP）", async () =>
        backupService.archiveTableByDay({
          tableName: "vehicle_passageway_logs",
          rows: await backupService.getVehiclePassagewayForBackup(
            archiveBeforeDate,
            "yscp", archiveStartDate,
          ),
          dateField: "trigger_time",
          category: "vehicleAccess",
          csvTransform: (dayRows) =>
            transformVehicleAccessToReportFormat(dayRows, vehicleReportOpts),
        }),
      );
    }

    const vehicleIsapiResult = await runBackupJob("車輛進出（ISAPI）", async () =>
      backupService.archiveTableByDay({
        tableName: "vehicle_passageway_logs_isapi",
        rows: await backupService.getVehiclePassagewayForBackup(
          archiveBeforeDate,
          "isapi_camera", archiveStartDate,
        ),
        dateField: "trigger_time",
        category: "vehicleAccess",
        csvTransform: (dayRows) =>
          transformVehicleAccessToReportFormat(dayRows, vehicleReportOpts),
        attachmentSubdir: "vehicle_access/attachments",
        attachmentNamePrefix: "vehicle_",
      }),
    );

    let ladderResult = { skipped: true };
    if (effectiveFeaturesCache.hasCachedLicensedFeature("elevator")) {

      ladderResult = await runBackupJob("梯控（SDK）", async () =>
        backupService.archiveTableByDay({
          tableName: "ladder_sdk_events",
          rows: await backupService.getLadderSdkEventsForBackup(
            archiveBeforeDate, archiveStartDate,
          ),
          dateField: "event_time",
          category: "elevator",
          csvTransform: transformLadderSdkEventsToReportFormat,
        }),
      );
    }

    let energyResult = { skipped: true };
    if (effectiveFeaturesCache.hasCachedLicensedFeature("energy")) {

      energyResult = await runBackupJob("能源讀數", async () =>
        backupService.archiveTableByDay({
          tableName: "energy_readings",
          rows: await energyReadingsService.getReadingsForBackup(
            archiveBeforeDate, archiveStartDate,
          ),
          dateField: "recorded_at",
          category: "energyReadings",
          csvTransform: transformEnergyReadingsToReportFormat,
        }),
      );
    }

    const operationalResult = await runBackupJob("營運事件", async () =>
      backupService.archiveTableByDay({
        tableName: "operational_events",
        rows: await backupService.getOperationalEventsForBackup(
          archiveBeforeDate, archiveStartDate,
        ),
        dateField: "created_at",
        category: "operationalEvents",
        csvTransform: transformOperationalEventsToReportFormat,
      }),
    );

    const results = {
      environment_readings: envResult,
      alerts: alertResult,
      people_counting_logs: peopleYscpResult,
      isapi_access_events: peopleAccessIsapiResult,
      isapi_people_counting_events: peopleCameraIsapiResult,
      isapi_face_contrast_events: peopleFaceContrastIsapiResult,
      vehicle_passageway_logs: vehicleYscpResult,
      vehicle_passageway_logs_isapi: vehicleIsapiResult,
      ladder_sdk_events: ladderResult,
      energy_readings: energyResult,
      operational_events: operationalResult,
    };

    const backed = Object.values(results).reduce((total, result) => total + (result?.count || 0), 0);
    const backupMeta = {
      totalBacked: backed,
      module: "backupScheduler",
    };
    if (backed === 0) {
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

function startScheduler() {
  const { retention, scheduler } = getBackupConfig();
  const alerts = runtimeConfigService.getAlerts();

  if (schedulerHandle?.stop) {
    schedulerHandle.stop();
    schedulerHandle = null;
  }

  const core = createDailyLocalScheduler({
    name: "backup",
    getSchedule: () => {
      const liveAlerts = runtimeConfigService.getAlerts();
      const { scheduler: liveScheduler } = getBackupConfig();
      return {
        enabled: true,
        timezone: liveAlerts.dailyRolloverTimezone,
        hour: liveScheduler.dailyLocalHour,
        minute: liveScheduler.dailyLocalMinute,
      };
    },
    runJob: () => runBackupOnce(),
    runOnStart: true,
  });

  schedulerHandle = core.startScheduler();

  backupLogger.info("備份排程已啟動", {
    dailyLocalTime: `${String(scheduler.dailyLocalHour).padStart(2, "0")}:${String(scheduler.dailyLocalMinute).padStart(2, "0")}`,
    timezone: alerts.dailyRolloverTimezone,
    archiveAfterDays: retention.archiveAfterDays,
    onlineRetentionDays: retention.onlineRetentionDays,
    module: "backupScheduler",
  });

  return schedulerHandle;
}

module.exports = {
  runBackup,
  runBackupOnce,
  startScheduler,
};
