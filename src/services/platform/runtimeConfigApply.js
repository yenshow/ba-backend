/**
 * 將 runtime 設定變更套用至連線池與背景排程（由 server 啟動時註冊）
 */

const externalDb = require("../../database/externalDb");
const runtimeConfigService = require("./runtimeConfigService");
const { isDatabaseEnabled } = require("../../utils/yscpSystemFeature");
const backupScheduler = require("../backup/backupScheduler");
const {
  startAlertDailyRolloverScheduler,
  stopAlertDailyRolloverScheduler,
} = require("../alerts/alertRolloverScheduler");
const logger = require("../../utils/logger");

const applyLogger = logger.createLogger("runtimeConfigApply");

const YSCP_DB_DISABLED_LOG = "YSCP 外部資料庫已關閉";

async function bootstrapRuntimeInfrastructure() {
  runtimeConfigService.registerApplyHooks({
    onYscpChange: async () => {
      if (!isDatabaseEnabled()) {
        await externalDb.close();
        applyLogger.info(`${YSCP_DB_DISABLED_LOG}，略過連線`);
        return {
          ok: false,
          skipped: true,
          message: "YSCP 外部資料庫功能已關閉（ENABLE_YSCP_DATABASE=false）",
        };
      }
      await externalDb.reconnect(runtimeConfigService.getExternalDatabase());
      const ok = await externalDb.testConnection();
      if (!ok) {
        applyLogger.warn("YSCP 設定已更新，但外部資料庫連線測試失敗");
        return { ok: false, message: "外部資料庫連線測試失敗" };
      }
      return { ok: true, message: "外部資料庫連線成功" };
    },
    onAlertsChange: async () => {
      stopAlertDailyRolloverScheduler();
      global.__alertRolloverStop = startAlertDailyRolloverScheduler();
      applyLogger.info("警報日界線排程已依新設定重排");
      return { ok: true, message: "警報日界線排程已重排" };
    },
    onBackupChange: async () => {
      global.__backupSchedulerHandle?.stop?.();
      global.__backupSchedulerHandle = backupScheduler.startScheduler();
      applyLogger.info("備份排程已依新設定重啟");
      return { ok: true, message: "備份排程已重啟" };
    },
  });

  await runtimeConfigService.init();
  if (!isDatabaseEnabled()) {
    applyLogger.info(`${YSCP_DB_DISABLED_LOG}，略過連線池初始化`);
    return;
  }
  await externalDb.reconnect(runtimeConfigService.getExternalDatabase());
}

module.exports = { bootstrapRuntimeInfrastructure };
