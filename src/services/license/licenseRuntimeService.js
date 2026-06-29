/**
 * 依 License 協調背景監控、環境彙總、ISAPI Hub、梯控 SDK。
 * 觸發：後端啟動、授權啟用/重置（見 licenseRoutes）。
 */
const logger = require("../../utils/logger").createLogger("licenseRuntime");
const licenseService = require("./licenseService");
const backgroundMonitor = require("../monitoring/backgroundMonitor");
const {
  getLicensedMonitoringTasks,
} = require("../monitoring/monitoringTaskRegistry");
const {
  startEnvironmentAggregationScheduler,
  stopEnvironmentAggregationScheduler,
} = require("../environment/environmentAggregationScheduler");
const isapiSubscribeHub = require("../isapi/isapiSubscribeHub");
const sdkArmingService = require("../ladderSdk/sdkArmingService");
const { setCachedEffectiveFeatures } = require("./effectiveFeaturesCache");

let elevatorArmed = false;

const reconcileElevatorSdk = async (features) => {
  const licensed = licenseService.hasLicensedFeature(features, "elevator");
  if (!licensed) {
    if (elevatorArmed) {
      sdkArmingService.stop();
      elevatorArmed = false;
    }
    return { armed: false };
  }

  if (!elevatorArmed) {
    try {
      await sdkArmingService.start();
      elevatorArmed = true;
    } catch (error) {
      logger.warn("梯控 SDK 佈防啟動失敗", {
        error: error?.message || String(error),
      });
    }
  }

  return { armed: true };
};

const reconcileBackgroundServices = async ({
  reason = "unknown",
  licensedFeatures,
} = {}) => {
  const features =
    licensedFeatures ?? (await licenseService.getEffectiveLicensedFeatures());
  setCachedEffectiveFeatures(features);

  const desiredTasks = getLicensedMonitoringTasks(features);
  const monitoring = backgroundMonitor.syncMonitoringTasks(desiredTasks);

  const environmentOn = licenseService.hasLicensedFeature(features, "environment");
  if (environmentOn) {
    startEnvironmentAggregationScheduler();
  } else {
    stopEnvironmentAggregationScheduler();
  }

  const isapi = await isapiSubscribeHub.reconcile({ licensedFeatures: features });
  const elevator = await reconcileElevatorSdk(features);

  logger.info("背景服務 reconcile 完成", {
    reason,
    monitoringTaskCount: monitoring.taskCount,
    environment: environmentOn ? "on" : "off",
    isapi: isapi.profileKeys || [],
    elevator: elevator.armed ? "on" : "off",
  });

  if (monitoring.startedNow && monitoring.taskNames.length > 0) {
    logger.info(
      `背景監控已啟動（Mode A 自適應排程；任務: ${monitoring.taskNames.join("、")}；共 ${monitoring.taskCount} 個）`,
    );
  }

  logger.debug("背景服務 reconcile 詳情", {
    reason,
    features,
    monitoringTaskIds: monitoring.taskIds,
  });

  return {
    features,
    monitoring,
    environment: environmentOn,
    isapi,
    elevator,
  };
};

const stopLicensedBackgroundServices = async () => {
  await backgroundMonitor.stopMonitoring();
  stopEnvironmentAggregationScheduler();
  isapiSubscribeHub.stop();
  sdkArmingService.stop();
  elevatorArmed = false;
  setCachedEffectiveFeatures([]);
};

module.exports = {
  reconcileBackgroundServices,
  stopLicensedBackgroundServices,
};
