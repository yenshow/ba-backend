const { getModuleDisplayNameByCode } = require("../../access/catalog");
const {
  STANDARD_POLL_MS,
  fixedIntervalOptions,
} = require("../../config/realtimeTiming");
const { createSystemSnapshotMonitor } = require("./systemSnapshotMonitorFactory");
const lightingStatusService = require("../snapshotStatus/lightingStatusService");
const hvacStatusService = require("../snapshotStatus/hvacStatusService");
const drainageStatusService = require("../snapshotStatus/drainageStatusService");
const powerStatusService = require("../snapshotStatus/powerStatusService");
const fireStatusService = require("../snapshotStatus/fireStatusService");
const emergencyRescueStatusService = require("../snapshotStatus/emergencyRescueStatusService");
const airCirculationStatusService = require("../snapshotStatus/airCirculationStatusService");
const smokeAlarmStatusService = require("../snapshotStatus/smokeAlarmStatusService");
const securityStatusService = require("../snapshotStatus/securityStatusService");

const SNAPSHOT_TASK_DEFS = [
  {
    systemKey: "lighting",
    systemName: "照明系統",
    statusService: lightingStatusService,
    getDeviceId: (item) => item?.deviceId ?? null,
  },
  { systemKey: "hvac", systemName: "空調系統", statusService: hvacStatusService },
  {
    systemKey: "drainage",
    systemName: getModuleDisplayNameByCode("system.drainage") ?? "排水系統",
    statusService: drainageStatusService,
  },
  { systemKey: "power", systemName: "電力系統", statusService: powerStatusService },
  {
    systemKey: "air_circulation",
    systemName: "空氣循環系統",
    statusService: airCirculationStatusService,
    loggerName: "airCirculationMonitor",
  },
  { systemKey: "fire", systemName: "消防系統", statusService: fireStatusService },
  {
    systemKey: "emergency_rescue",
    systemName: "緊急求救系統",
    statusService: emergencyRescueStatusService,
    loggerName: "emergencyRescueMonitor",
  },
  {
    systemKey: "smoke_alarm",
    systemName: "煙霧警報系統",
    statusService: smokeAlarmStatusService,
    loggerName: "smokeAlarmMonitor",
  },
  {
    systemKey: "security",
    systemName: "保全系統",
    statusService: securityStatusService,
  },
];

const SNAPSHOT_STAGGER_MS = 2000;

module.exports = SNAPSHOT_TASK_DEFS.map(
  (definition, index) => {
    const {
      systemKey,
      systemName,
      statusService,
      loggerName = `${systemKey}Monitor`,
      getDeviceId,
    } = definition;
    const monitor = createSystemSnapshotMonitor({
      systemKey,
      loggerName,
      getSnapshot: () => statusService.getStatusSnapshot(),
      getDeviceId,
    });
    return {
      taskId: systemKey,
      systemName,
      featureKey: systemKey,
      taskFunction: monitor.check,
      options: {
        ...fixedIntervalOptions(STANDARD_POLL_MS),
        startOffsetMs: index * SNAPSHOT_STAGGER_MS,
      },
    };
  },
);
