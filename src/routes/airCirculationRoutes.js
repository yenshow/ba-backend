const { createSnapshotSystemRouter } = require("./snapshotSystemRoutesFactory");
const airCirculationStatusService = require("../services/snapshotStatus/airCirculationStatusService");

module.exports = createSnapshotSystemRouter({
  permissionCode: "system.air_circulation",
  locationType: "air_circulation",
  alertSource: "air_circulation",
  statusService: airCirculationStatusService,
  requireAdminOrOperatorOnZoneMutations: true,
  statusSyncAlerts: "opt-out",
});
