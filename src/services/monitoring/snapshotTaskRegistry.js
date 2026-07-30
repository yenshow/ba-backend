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

const drainageSnapshotMonitor = createSystemSnapshotMonitor({
  systemKey: "drainage",
  loggerName: "drainageMonitor",
  getSnapshot: () => drainageStatusService.getStatusSnapshot(),
});

const powerSnapshotMonitor = createSystemSnapshotMonitor({
  systemKey: "power",
  loggerName: "powerMonitor",
  getSnapshot: () => powerStatusService.getStatusSnapshot(),
});

const fireSnapshotMonitor = createSystemSnapshotMonitor({
  systemKey: "fire",
  loggerName: "fireMonitor",
  getSnapshot: () => fireStatusService.getStatusSnapshot(),
});

const emergencyRescueSnapshotMonitor = createSystemSnapshotMonitor({
  systemKey: "emergency_rescue",
  loggerName: "emergencyRescueMonitor",
  getSnapshot: () => emergencyRescueStatusService.getStatusSnapshot(),
});

const airCirculationSnapshotMonitor = createSystemSnapshotMonitor({
  systemKey: "air_circulation",
  loggerName: "airCirculationMonitor",
  getSnapshot: () => airCirculationStatusService.getStatusSnapshot(),
});

const lightingSnapshotMonitor = createSystemSnapshotMonitor({
  systemKey: "lighting",
  loggerName: "lightingMonitor",
  getSnapshot: () => lightingStatusService.getStatusSnapshot(),
  getDeviceId: (item) => item?.deviceId ?? null,
});

const hvacSnapshotMonitor = createSystemSnapshotMonitor({
  systemKey: "hvac",
  loggerName: "hvacMonitor",
  getSnapshot: () => hvacStatusService.getStatusSnapshot(),
});

const smokeAlarmSnapshotMonitor = createSystemSnapshotMonitor({
  systemKey: "smoke_alarm",
  loggerName: "smokeAlarmMonitor",
  getSnapshot: () => smokeAlarmStatusService.getStatusSnapshot(),
});

const SNAPSHOT_TASK_DEFS = [
  { systemKey: "lighting", systemName: "照明系統", monitor: lightingSnapshotMonitor },
  { systemKey: "hvac", systemName: "空調系統", monitor: hvacSnapshotMonitor },
  {
    systemKey: "drainage",
    systemName: getModuleDisplayNameByCode("system.drainage") ?? "排水系統",
    monitor: drainageSnapshotMonitor,
  },
  { systemKey: "power", systemName: "電力系統", monitor: powerSnapshotMonitor },
  {
    systemKey: "air_circulation",
    systemName: "空氣循環系統",
    monitor: airCirculationSnapshotMonitor,
  },
  { systemKey: "fire", systemName: "消防系統", monitor: fireSnapshotMonitor },
  {
    systemKey: "emergency_rescue",
    systemName: "緊急求救系統",
    monitor: emergencyRescueSnapshotMonitor,
  },
  {
    systemKey: "smoke_alarm",
    systemName: "煙霧警報系統",
    monitor: smokeAlarmSnapshotMonitor,
  },
];

module.exports = SNAPSHOT_TASK_DEFS.map(({ systemKey, systemName, monitor }) => ({
  taskId: systemKey,
  systemName,
  featureKey: systemKey,
  taskFunction: () => monitor.check(),
  options: fixedIntervalOptions(STANDARD_POLL_MS),
}));
