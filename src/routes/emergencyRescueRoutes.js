const { createSnapshotSystemRouter } = require("./snapshotSystemRoutesFactory");
const emergencyRescueStatusService = require("../services/snapshotStatus/emergencyRescueStatusService");

module.exports = createSnapshotSystemRouter({
  permissionCode: "system.emergency_rescue",
  locationType: "emergency_rescue",
  alertSource: "emergency_rescue",
  statusService: emergencyRescueStatusService,
  statusSyncAlerts: "opt-in",
  createZoneHttpStatus: 201,
});
