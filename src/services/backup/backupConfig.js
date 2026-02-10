/**
 * 備份系統配置
 */

const path = require("path");

const backupConfig = {
  directories: {
    root: path.join(process.cwd(), "backups"),
    alerts: path.join(process.cwd(), "backups", "alerts"),
    environmentReadings: path.join(process.cwd(), "backups", "environment_readings"),
    peopleCounting: path.join(process.cwd(), "backups", "people_counting"),
  },

  retention: {
    databaseDays:
      parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || 30,
    backupFileDays:
      parseInt(process.env.BACKUP_FILE_RETENTION_DAYS, 10) || 365,
  },

  scheduler: {
    enabled: process.env.BACKUP_SCHEDULER_ENABLED !== "false",
    interval:
      parseInt(process.env.BACKUP_SCHEDULER_INTERVAL, 10) ||
      24 * 60 * 60 * 1000,
  },

  compression: {
    enabled: process.env.BACKUP_COMPRESSION_ENABLED === "true",
  },
};

module.exports = backupConfig;
