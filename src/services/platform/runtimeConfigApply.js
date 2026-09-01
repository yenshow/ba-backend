/**
 * 將 runtime 設定變更套用至連線池與背景排程（由 server 啟動時註冊）
 */

const runtimeConfigService = require("./runtimeConfigService");
const yscpRuntimeService = require("../yscp/yscpRuntimeService");
const backupScheduler = require("../backup/backupScheduler");
const isapiTimeSyncScheduler = require("../isapi/isapiTimeSyncScheduler");
const {
  startAlertDailyRolloverScheduler,
  stopAlertDailyRolloverScheduler,
} = require("../alerts/alertRolloverScheduler");
const logger = require("../../utils/logger");

const applyLogger = logger.createLogger("runtimeConfigApply");

async function bootstrapRuntimeInfrastructure() {
  runtimeConfigService.registerApplyHooks({
    onAlertsChange: async () => {
      stopAlertDailyRolloverScheduler();
      global.__alertRolloverStop = startAlertDailyRolloverScheduler();
      applyLogger.info("警報日界線排程已依新設定重排");
    },
    onBackupChange: async () => {
      global.__backupSchedulerHandle?.stop?.();
      global.__backupSchedulerHandle = backupScheduler.startScheduler();
      applyLogger.info("備份排程已依新設定重啟");
    },
    onIsapiTimeSyncChange: async () => {
      global.__isapiTimeSyncHandle?.stop?.();
      global.__isapiTimeSyncHandle = isapiTimeSyncScheduler.startScheduler();
      applyLogger.info("ISAPI 校時排程已依新設定重啟");
    },
  });

  await runtimeConfigService.init();
  await yscpRuntimeService.start();
}

module.exports = { bootstrapRuntimeInfrastructure };
