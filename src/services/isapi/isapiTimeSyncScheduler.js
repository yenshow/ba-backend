const { createDailyLocalScheduler } = require("../../utils/dailyLocalScheduler");
const runtimeConfigService = require("../platform/runtimeConfigService");
const isapiTimeSyncService = require("./isapiTimeSyncService");

const schedulerCore = createDailyLocalScheduler({
  name: "isapiTimeSync",
  getSchedule: () => {
    const cfg = runtimeConfigService.getIsapiTimeSync();
    return {
      enabled: cfg.enabled,
      timezone: cfg.timezone,
      hour: cfg.scheduler.dailyLocalHour,
      minute: cfg.scheduler.dailyLocalMinute,
    };
  },
  runJob: () => isapiTimeSyncService.syncAllIsapiDevices(),
  runOnStart: false,
});

function startScheduler() {
  return schedulerCore.startScheduler();
}

module.exports = {
  startScheduler,
};
