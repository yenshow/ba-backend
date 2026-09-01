const runtimeConfigService = require("../platform/runtimeConfigService");
const logger = require("../../utils/logger");
const alertService = require("./alertService");
const { createDailyLocalScheduler } = require("../../utils/dailyLocalScheduler");

const rolloverLogger = logger.createLogger("alertRollover");

let schedulerHandle = null;

const schedulerCore = createDailyLocalScheduler({
  name: "alertRollover",
  getSchedule: () => {
    const alerts = runtimeConfigService.getAlerts();
    return {
      enabled: alerts.dailyRolloverEnabled,
      timezone: alerts.dailyRolloverTimezone,
      hour: alerts.dailyRolloverLocalHour,
      minute: alerts.dailyRolloverLocalMinute,
    };
  },
  runJob: async () => {
    const alerts = runtimeConfigService.getAlerts();
    const r = await alertService.resolveAllActiveForDailyRollover();
    if (r.resolvedCount > 0) {
      rolloverLogger.info("警報日界線結案完成", {
        resolvedCount: r.resolvedCount,
        timezone: alerts.dailyRolloverTimezone,
      });
    }
  },
});

function startAlertDailyRolloverScheduler() {
  if (!runtimeConfigService.getAlerts().dailyRolloverEnabled) {
    rolloverLogger.info("警報日界線排程已停用");
    return () => {};
  }

  if (schedulerHandle?.stop) {
    schedulerHandle.stop();
  }
  schedulerHandle = schedulerCore.startScheduler();
  return stopAlertDailyRolloverScheduler;
}

function stopAlertDailyRolloverScheduler() {
  if (schedulerHandle?.stop) {
    schedulerHandle.stop();
    schedulerHandle = null;
  }
}

module.exports = {
  startAlertDailyRolloverScheduler,
  stopAlertDailyRolloverScheduler,
};
