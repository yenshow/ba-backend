/**
 * 將 runtime 設定變更套用至連線池與背景排程（由 server 啟動時註冊）
 */

const externalDb = require("../../database/externalDb");
const runtimeConfigService = require("./runtimeConfigService");
const backupScheduler = require("../backup/backupScheduler");
const {
  startAlertDailyRolloverScheduler,
  stopAlertDailyRolloverScheduler,
} = require("../alerts/alertRolloverScheduler");
const logger = require("../../utils/logger");

const applyLogger = logger.createLogger("runtimeConfigApply");

async function bootstrapRuntimeInfrastructure() {
  runtimeConfigService.registerApplyHooks({
    onYscpChange: async () => {
      await externalDb.reconnect(runtimeConfigService.getExternalDatabase());
      if (!(await externalDb.testConnection())) {
        applyLogger.warn("YSCP 設定已更新，但外部資料庫連線測試失敗");
      }
    },
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
  });

  await runtimeConfigService.init();
  await externalDb.reconnect(runtimeConfigService.getExternalDatabase());
}

module.exports = { bootstrapRuntimeInfrastructure };
