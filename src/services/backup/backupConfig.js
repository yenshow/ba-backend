/**
 * 備份系統配置
 *
 * 環境變數（建議新鍵；舊鍵仍相容）：
 * - BACKUP_DATABASE_CUTOFF_DAYS / BACKUP_RETENTION_DAYS：線上 DB 熱資料截止天數
 * - BACKUP_ARCHIVE_FILE_RETENTION_DAYS / BACKUP_FILE_RETENTION_DAYS：backups/ CSV 保留（mtime）
 * - BACKUP_SCHEDULER_INTERVAL：排程間隔（毫秒）
 */

const path = require("path");

const BACKUP_ROOT = path.join(process.cwd(), "backups");

function envFirst(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const backupConfig = {
  directories: {
    root: BACKUP_ROOT,
    alerts: path.join(BACKUP_ROOT, "alerts"),
    environmentReadings: path.join(BACKUP_ROOT, "environment_readings"),
    peopleCounting: path.join(BACKUP_ROOT, "people_counting"),
    vehicleAccess: path.join(BACKUP_ROOT, "vehicle_access"),
  },

  retention: {
    databaseDays: parsePositiveInt(
      envFirst("BACKUP_DATABASE_CUTOFF_DAYS", "BACKUP_RETENTION_DAYS"),
      30,
    ),
    backupFileDays: parsePositiveInt(
      envFirst("BACKUP_ARCHIVE_FILE_RETENTION_DAYS", "BACKUP_FILE_RETENTION_DAYS"),
      365,
    ),
  },

  scheduler: {
    interval: parsePositiveInt(
      process.env.BACKUP_SCHEDULER_INTERVAL,
      24 * 60 * 60 * 1000,
    ),
  },
};

module.exports = backupConfig;
