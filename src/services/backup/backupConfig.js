/**
 * 備份系統配置
 */

const path = require("path");
const runtimeConfigService = require("../platform/runtimeConfigService");
const { getBackupRootDir } = require("../../utils/baDataPaths");

const resolveBackupRoot = () => {
  const fromRuntime = String(runtimeConfigService.getBackup?.()?.rootDir || "").trim();
  if (fromRuntime) {
    return path.resolve(fromRuntime);
  }
  return getBackupRootDir();
};

function getBackupConfig() {
  const runtime = runtimeConfigService.getBackup();
  const root = resolveBackupRoot();
  return {
    directories: {
      root,
      alerts: path.join(root, "alerts"),
      environmentReadings: path.join(root, "environment_readings"),
      peopleCounting: path.join(root, "people_counting"),
      vehicleAccess: path.join(root, "vehicle_access"),
      elevator: path.join(root, "elevator"),
    },
    retention: runtime.retention,
    scheduler: runtime.scheduler,
  };
}

module.exports = {
  getBackupConfig,
};
