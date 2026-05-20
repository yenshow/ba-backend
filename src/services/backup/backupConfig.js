/**
 * 備份系統配置
 * - 優先：runtime（system_settings）BACKUP_ROOT_DIR（可由 /core/env 修改，立即生效）
 * - fallback：{cwd}/backups
 */

const path = require("path");
const runtimeConfigService = require("../platform/runtimeConfigService");

const resolveBackupRoot = () => {
  const fromRuntime = String(runtimeConfigService.getBackup?.()?.rootDir || "").trim();
  if (fromRuntime) {
    return path.resolve(fromRuntime);
  }
  return path.join(process.cwd(), "backups");
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
    },
    retention: runtime.retention,
    scheduler: runtime.scheduler,
  };
}

module.exports = {
  getBackupConfig,
};
