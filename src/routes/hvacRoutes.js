const { createSnapshotSystemRouter } = require("./snapshotSystemRoutesFactory");
const hvacStatusService = require("../services/snapshotStatus/hvacStatusService");

module.exports = createSnapshotSystemRouter({
  permissionCode: "system.hvac",
  locationType: "hvac",
  alertSource: "hvac",
  statusService: hvacStatusService,
  statusSyncAlerts: "opt-out",
});
