/**
 * 備份系統配置（目錄固定；保留天數與排程間隔由 runtimeConfigService 提供）
 */

const path = require("path");
const runtimeConfigService = require("../runtimeConfigService");

const BACKUP_ROOT = path.join(process.cwd(), "backups");

function getBackupConfig() {
  const runtime = runtimeConfigService.getBackup();
  return {
    directories: {
      root: BACKUP_ROOT,
      alerts: path.join(BACKUP_ROOT, "alerts"),
      environmentReadings: path.join(BACKUP_ROOT, "environment_readings"),
      peopleCounting: path.join(BACKUP_ROOT, "people_counting"),
      vehicleAccess: path.join(BACKUP_ROOT, "vehicle_access"),
    },
    retention: runtime.retention,
    scheduler: runtime.scheduler,
  };
}

module.exports = {
  getBackupConfig,
  BACKUP_ROOT,
};
