const { createSnapshotSystemRouter } = require("./snapshotSystemRoutesFactory");
const powerStatusService = require("../services/snapshotStatus/powerStatusService");

module.exports = createSnapshotSystemRouter({
  permissionCode: "system.power",
  locationType: "power",
  alertSource: "power",
  statusService: powerStatusService,
  statusSyncAlerts: "opt-in",
  createZoneHttpStatus: 201,
});
