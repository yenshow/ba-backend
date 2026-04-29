const environmentMonitor = require("./environmentMonitor");
const snapshotTaskRegistry = require("./snapshotTaskRegistry");
const diDoMonitor = require("./diDoMonitor");
const {
  processActiveAlertEmailResends,
} = require("../alerts/alertEmailNotifier");

const nonSnapshotTaskRegistry = [
  {
    systemName: "環境系統",
    taskFunction: environmentMonitor.checkEnvironmentLocations,
  },
  {
    systemName: "DI/DO 泛用警報",
    taskFunction: diDoMonitor.checkDiDoAlerts,
    options: {
      baseIntervalMs: 5000,
      minIntervalMs: 5000,
      maxIntervalMs: 5000,
    },
  },
  {
    systemName: "警報 Email 重送",
    taskFunction: async () => {
      await processActiveAlertEmailResends({ limit: 50 });
      return { nextIntervalMs: 15_000 };
    },
    options: {
      baseIntervalMs: 15_000,
      minIntervalMs: 15_000,
      maxIntervalMs: 15_000,
    },
  },
];

const monitoringTaskRegistry = [
  ...nonSnapshotTaskRegistry,
  ...snapshotTaskRegistry,
];

module.exports = monitoringTaskRegistry;
