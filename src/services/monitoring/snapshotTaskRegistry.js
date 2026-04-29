const { createSystemSnapshotMonitor } = require("./systemSnapshotMonitorFactory");
const lightingStatusService = require("../systems/lightingStatusService");
const hvacStatusService = require("../systems/hvacStatusService");
const drainageStatusService = require("../systems/drainageStatusService");
const powerStatusService = require("../systems/powerStatusService");
const fireStatusService = require("../systems/fireStatusService");
const emergencyRescueStatusService = require("../systems/emergencyRescueStatusService");
const airCirculationStatusService = require("../systems/airCirculationStatusService");

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

const snapshotTaskRegistry = [
  {
    systemName: "照明系統",
    taskFunction: () => lightingSnapshotMonitor.check(),
  },
  {
    systemName: "空調系統",
    taskFunction: () => hvacSnapshotMonitor.check(),
  },
  {
    systemName: "衛生排水系統",
    taskFunction: () => drainageSnapshotMonitor.check(),
  },
  {
    systemName: "電力系統",
    taskFunction: () => powerSnapshotMonitor.check(),
  },
  {
    systemName: "空氣循環系統",
    taskFunction: () => airCirculationSnapshotMonitor.check(),
  },
  {
    systemName: "消防系統",
    taskFunction: () => fireSnapshotMonitor.check(),
  },
  {
    systemName: "緊急求救系統",
    taskFunction: () => emergencyRescueSnapshotMonitor.check(),
  },
];

module.exports = snapshotTaskRegistry;
