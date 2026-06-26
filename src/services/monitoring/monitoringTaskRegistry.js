const environmentMonitor = require("./environmentMonitor");
const {
  checkElevatorRuntime,
} = require("./elevatorFloorDetectionMonitor");
const snapshotTaskRegistry = require("./snapshotTaskRegistry");
const {
  checkDiDoAlerts,
  DI_DO_ALERT_FEATURE_KEYS,
} = require("./diDoMonitor");
const deviceConnectivityService = require("../devices/deviceConnectivityService");
const {
  processActiveAlertEmailResends,
} = require("../alerts/alertEmailNotifier");

const TASK_IDS = {
  deviceConnectivity: "platform:device_connectivity",
  alertEmailResend: "platform:alert_email_resend",
  diDo: "platform:di_do",
};

const monitoringTaskRegistry = [
  {
    taskId: TASK_IDS.deviceConnectivity,
    systemName: "設備連線狀態",
    taskFunction: async () => {
      await deviceConnectivityService.checkAndBroadcastConnectivity();
      return { nextIntervalMs: 15_000 };
    },
    options: {
      baseIntervalMs: 15_000,
      minIntervalMs: 15_000,
      maxIntervalMs: 15_000,
    },
  },
  {
    taskId: "environment",
    systemName: "環境系統",
    featureKey: "environment",
    taskFunction: environmentMonitor.checkEnvironmentLocations,
  },
  {
    taskId: "elevator",
    systemName: "電梯運行態",
    featureKey: "elevator",
    taskFunction: checkElevatorRuntime,
    options: {
      baseIntervalMs: 2000,
      minIntervalMs: 2000,
      maxIntervalMs: 2000,
    },
  },
  {
    taskId: TASK_IDS.diDo,
    systemName: "DI/DO 泛用警報",
    requiresAnyFeature: DI_DO_ALERT_FEATURE_KEYS,
    taskFunction: checkDiDoAlerts,
    options: {
      baseIntervalMs: 5000,
      minIntervalMs: 5000,
      maxIntervalMs: 5000,
    },
  },
  {
    taskId: TASK_IDS.alertEmailResend,
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
  ...snapshotTaskRegistry,
];

const getLicensedMonitoringTasks = (licensedFeatures) => {
  const licensed = new Set(
    Array.isArray(licensedFeatures)
      ? licensedFeatures.filter((k) => typeof k === "string")
      : [],
  );

  return monitoringTaskRegistry.filter((task) => {
    if (task.requiresAnyFeature?.length) {
      return task.requiresAnyFeature.some((key) => licensed.has(key));
    }
    if (!task.featureKey) {
      return true;
    }
    return licensed.has(task.featureKey);
  });
};

module.exports = {
  getLicensedMonitoringTasks,
  TASK_IDS,
};
