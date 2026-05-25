const { createSnapshotSystemRouter } = require("./snapshotSystemRoutesFactory");
const drainageStatusService = require("../services/snapshotStatus/drainageStatusService");

module.exports = createSnapshotSystemRouter({
  permissionCode: "system.drainage",
  locationType: "drainage",
  alertSource: "drainage",
  statusService: drainageStatusService,
  statusSyncAlerts: "opt-in",
  createZoneHttpStatus: 201,
});
