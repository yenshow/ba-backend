/**
 * 將 runtime 設定變更套用至連線池與背景排程（由 server 啟動時註冊）
 */

const externalDb = require("../../database/externalDb");
const config = require("../../config");
const runtimeConfigService = require("./runtimeConfigService");
const { isDatabaseEnabled } = require("../../utils/yscpSystemFeature");
const backupScheduler = require("../backup/backupScheduler");
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
  });

  await runtimeConfigService.init();
  if (!isDatabaseEnabled()) {
    applyLogger.info("YSCP 外部資料庫已關閉，略過連線池初始化");
    return;
  }
  await externalDb.reconnect(config.externalDatabase);
}

module.exports = { bootstrapRuntimeInfrastructure };
