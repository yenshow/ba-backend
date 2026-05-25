const { createSnapshotSystemRouter } = require("./snapshotSystemRoutesFactory");
const smokeAlarmStatusService = require("../services/snapshotStatus/smokeAlarmStatusService");

module.exports = createSnapshotSystemRouter({
  permissionCode: "system.smoke_alarm",
  locationType: "smoke_alarm",
  alertSource: "smoke_alarm",
  statusService: smokeAlarmStatusService,
  statusSyncAlerts: "opt-in",
  createZoneHttpStatus: 201,
  manualErrorRequiresMessage: true,
});
