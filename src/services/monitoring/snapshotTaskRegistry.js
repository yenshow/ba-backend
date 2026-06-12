const { getModuleDisplayNameByCode } = require("../../access/catalog");
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
    systemName: getModuleDisplayNameByCode("system.drainage") ?? "排水系統",
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
  {
    systemName: "煙霧警報系統",
    taskFunction: () => smokeAlarmSnapshotMonitor.check(),
  },
];

module.exports = snapshotTaskRegistry;
