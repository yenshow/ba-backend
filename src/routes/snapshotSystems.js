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
const securityStatusService = require("../services/snapshotStatus/securityStatusService");

const SNAPSHOT_SYSTEMS = [
  {
    mountPath: "/api/lighting",
    featureKey: "lighting",
    config: {
      permissionCode: "system.lighting",
      locationType: "lighting",
      alertSource: "lighting",
      systemKey: "lighting",
      statusService: lightingStatusService,
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
      systemKey: "drainage",
      statusService: drainageStatusService,
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
      systemKey: "hvac",
      statusService: hvacStatusService,
    },
  },
  {
    mountPath: "/api/air-circulation",
    featureKey: "air_circulation",
    config: {
      permissionCode: "system.air_circulation",
      locationType: "air_circulation",
      alertSource: "air_circulation",
      systemKey: "air_circulation",
      statusService: airCirculationStatusService,
    },
  },
  {
    mountPath: "/api/power",
    featureKey: "power",
    config: {
      permissionCode: "system.power",
      locationType: "power",
      alertSource: "power",
      systemKey: "power",
      statusService: powerStatusService,
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
      systemKey: "fire",
      statusService: fireStatusService,
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
      systemKey: "emergency_rescue",
      statusService: emergencyRescueStatusService,
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
      systemKey: "smoke_alarm",
      statusService: smokeAlarmStatusService,
      createZoneHttpStatus: 201,
      manualErrorRequiresMessage: true,
    },
  },
  {
    mountPath: "/api/security",
    featureKey: "security",
    config: {
      permissionCode: "system.security",
      locationType: "security",
      alertSource: "security",
      systemKey: "security",
      statusService: securityStatusService,
      createZoneHttpStatus: 201,
    },
  },
];

const mountSnapshotSystemRoutes = (app, requireFeature) => {
  const securityScheduleRoutes = require("./securityScheduleRoutes");
  const lightingScheduleRoutes = require("./lightingScheduleRoutes");
  const hvacScheduleRoutes = require("./hvacScheduleRoutes");
  for (const entry of SNAPSHOT_SYSTEMS) {
    const router = createSnapshotSystemRouter(entry.config);
    // 保全／照明／空調排程掛同一 mountPath，避免 server.js 雙重 mount
    if (entry.featureKey === "security") {
      router.use(securityScheduleRoutes);
    }
    if (entry.featureKey === "lighting") {
      router.use(lightingScheduleRoutes);
    }
    if (entry.featureKey === "hvac") {
      router.use(hvacScheduleRoutes);
    }
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
