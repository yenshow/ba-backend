/**
 * Central 快照子系統路由（合併原 lighting/hvac/… 薄包裝）
 */
const { createSnapshotSystemRouter } = require("./snapshotSystemRoutesFactory");
const lightingStatusService = require("../services/snapshotStatus/lightingStatusService");
const hvacStatusService = require("../services/snapshotStatus/hvacStatusService");
const powerStatusService = require("../services/snapshotStatus/powerStatusService");
const drainageStatusService = require("../services/snapshotStatus/drainageStatusService");
const fireStatusService = require("../services/snapshotStatus/fireStatusService");
const airCirculationStatusService = require("../services/snapshotStatus/airCirculationStatusService");
const smokeAlarmStatusService = require("../services/snapshotStatus/smokeAlarmStatusService");
const emergencyRescueStatusService = require("../services/snapshotStatus/emergencyRescueStatusService");

const SNAPSHOT_SYSTEMS = [
  {
    mountPath: "/api/lighting",
    featureKey: "lighting",
    config: {
      permissionCode: "system.lighting",
      locationType: "lighting",
      alertSource: "lighting",
      statusService: lightingStatusService,
      statusSyncAlerts: "off",
      createZoneHttpStatus: 201,
    },
  },
  {
    mountPath: "/api/drainage",
    featureKey: "drainage",
    config: {
      permissionCode: "system.drainage",
      locationType: "drainage",
      alertSource: "drainage",
      statusService: drainageStatusService,
      statusSyncAlerts: "opt-in",
      createZoneHttpStatus: 201,
    },
  },
  {
    mountPath: "/api/hvac",
    featureKey: "hvac",
    config: {
      permissionCode: "system.hvac",
      locationType: "hvac",
      alertSource: "hvac",
      statusService: hvacStatusService,
      statusSyncAlerts: "opt-out",
    },
  },
  {
    mountPath: "/api/air-circulation",
    featureKey: "air_circulation",
    config: {
      permissionCode: "system.air_circulation",
      locationType: "air_circulation",
      alertSource: "air_circulation",
      statusService: airCirculationStatusService,
      statusSyncAlerts: "opt-out",
    },
  },
  {
    mountPath: "/api/power",
    featureKey: "power",
    config: {
      permissionCode: "system.power",
      locationType: "power",
      alertSource: "power",
      statusService: powerStatusService,
      statusSyncAlerts: "opt-in",
      createZoneHttpStatus: 201,
    },
  },
  {
    mountPath: "/api/fire",
    featureKey: "fire",
    config: {
      permissionCode: "system.fire",
      locationType: "fire",
      alertSource: "fire",
      statusService: fireStatusService,
      statusSyncAlerts: "opt-in",
      createZoneHttpStatus: 201,
    },
  },
  {
    mountPath: "/api/emergency-rescue",
    featureKey: "emergency_rescue",
    config: {
      permissionCode: "system.emergency_rescue",
      locationType: "emergency_rescue",
      alertSource: "emergency_rescue",
      statusService: emergencyRescueStatusService,
      statusSyncAlerts: "opt-in",
      createZoneHttpStatus: 201,
    },
  },
  {
    mountPath: "/api/smoke-alarm",
    featureKey: "smoke_alarm",
    config: {
      permissionCode: "system.smoke_alarm",
      locationType: "smoke_alarm",
      alertSource: "smoke_alarm",
      statusService: smokeAlarmStatusService,
      statusSyncAlerts: "opt-in",
      createZoneHttpStatus: 201,
      manualErrorRequiresMessage: true,
    },
  },
];

const mountSnapshotSystemRoutes = (app, requireFeature) => {
  for (const entry of SNAPSHOT_SYSTEMS) {
    const router = createSnapshotSystemRouter(entry.config);
    app.use(entry.mountPath, requireFeature(entry.featureKey), router);
  }
};

/** monitoring overview 聚合用；與 SNAPSHOT_SYSTEMS 共用定義，避免重複 permissionCode / locationType */
const getMonitoringOverviewSystems = () =>
  SNAPSHOT_SYSTEMS.map(({ featureKey, config }) => ({
    key: featureKey,
    featureKey,
    permissionCode: config.permissionCode,
    locationType: config.locationType,
    statusService: config.statusService,
  }));

module.exports = {
  mountSnapshotSystemRoutes,
  SNAPSHOT_SYSTEMS,
  getMonitoringOverviewSystems,
};
