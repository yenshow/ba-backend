/**
 * 備份系統配置管理
 * 集中管理所有備份相關的配置
 */

const path = require("path");

/**
 * 備份系統配置
 */
const backupConfig = {
  // 目錄配置
  directories: {
    root: path.join(process.cwd(), "backups"),
    alerts: path.join(process.cwd(), "backups", "alerts"),
    deviceLogs: path.join(process.cwd(), "backups", "device_logs"),
    cleanup: path.join(process.cwd(), "backups", "cleanup"),
  },

  // 保留策略
  retention: {
    database: {
      alerts: parseInt(process.env.BACKUP_DB_RETENTION_DAYS_ALERTS, 10) || 30, // 資料庫保留 30 天
      deviceDataLogs: parseInt(process.env.BACKUP_DB_RETENTION_DAYS_DEVICE_LOGS, 10) || 30,
    },
    backup: {
      alerts: parseInt(process.env.BACKUP_FILE_RETENTION_DAYS_ALERTS, 10) || 365, // 備份檔案保留 365 天
      deviceDataLogs: parseInt(process.env.BACKUP_FILE_RETENTION_DAYS_DEVICE_LOGS, 10) || 365,
      cleanup: parseInt(process.env.BACKUP_FILE_RETENTION_DAYS_CLEANUP, 10) || 365,
    },
  },

  // 備份格式
  formats: {
    default: ["json", "csv"],
    alerts: ["json", "csv"],
    deviceDataLogs: ["json", "csv"],
    cleanup: ["json"], // 清理備份通常只需要 JSON
  },

  // 命名規則
  naming: {
    strategy: process.env.BACKUP_NAMING_STRATEGY || "timestamp", // 'timestamp' | 'daily'
  },

  // 定時任務配置
  scheduler: {
    alerts: {
      enabled: process.env.BACKUP_SCHEDULER_ALERTS_ENABLED !== "false",
      interval: parseInt(process.env.BACKUP_SCHEDULER_ALERTS_INTERVAL, 10) || 24 * 60 * 60 * 1000, // 24 小時
    },
  },

  // 壓縮配置
  compression: {
    enabled: process.env.BACKUP_COMPRESSION_ENABLED === "true",
  },
};

module.exports = backupConfig;

