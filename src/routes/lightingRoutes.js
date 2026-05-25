const { createSnapshotSystemRouter } = require("./snapshotSystemRoutesFactory");
const lightingStatusService = require("../services/snapshotStatus/lightingStatusService");

module.exports = createSnapshotSystemRouter({
  permissionCode: "system.lighting",
  locationType: "lighting",
  alertSource: "lighting",
  statusService: lightingStatusService,
  statusSyncAlerts: "off",
  createZoneHttpStatus: 201,
});
