const { createSnapshotSystemRouter } = require("./snapshotSystemRoutesFactory");
const fireStatusService = require("../services/snapshotStatus/fireStatusService");

module.exports = createSnapshotSystemRouter({
  permissionCode: "system.fire",
  locationType: "fire",
  alertSource: "fire",
  statusService: fireStatusService,
  statusSyncAlerts: "opt-in",
  createZoneHttpStatus: 201,
});
