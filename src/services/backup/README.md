# 統一備份服務

## 概述

統一備份服務提供了一個集中化的備份系統，取代了原本分散的備份邏輯。

## 架構

```
src/services/backup/
├── backupConfig.js      # 備份配置管理
├── backupFormats.js     # 備份格式處理（JSON/CSV）
├── backupService.js     # 核心備份服務
└── backupScheduler.js   # 定時備份任務
```

## 使用方式

### 基本備份

```javascript
const backupService = require('./src/services/backup/backupService');

// 備份單一表
const result = await backupService.backupTable({
  tableName: 'alerts',
  query: 'SELECT * FROM alerts WHERE status = $1',
  params: ['resolved'],
  category: 'alerts',
  formats: ['json', 'csv'],
  deleteAfterBackup: false,
});
```

### 備份多個表

```javascript
const results = await backupService.backupMultiple({
  tables: [
    {
      tableName: 'device_data_logs',
      query: 'SELECT * FROM device_data_logs WHERE recorded_at < $1',
      params: [beforeDate],
      category: 'deviceLogs',
    },
    {
      tableName: 'alerts',
      query: 'SELECT * FROM alerts WHERE status = $1',
      params: ['resolved'],
      category: 'alerts',
    },
  ],
  deleteAfterBackup: false,
});
```

## 配置

配置可以透過環境變數或直接修改 `backupConfig.js`：

- `BACKUP_DB_RETENTION_DAYS_ALERTS` - 警報資料庫保留天數（預設：30）
- `BACKUP_FILE_RETENTION_DAYS_ALERTS` - 警報備份檔案保留天數（預設：365）
- `BACKUP_COMPRESSION_ENABLED` - 是否啟用壓縮（預設：false）
- `BACKUP_SCHEDULER_ALERTS_ENABLED` - 是否啟用定時任務（預設：true）

## 備份目錄結構

```
backups/
├── alerts/
│   ├── json/
│   └── csv/
├── device_logs/
│   ├── json/
│   └── csv/
└── cleanup/
```

## 相關檔案

- `scripts/backupData.js` - 主要備份腳本（已重構）
- `src/services/alerts/alertCleanupService.js` - 警報自動清理服務（已重構）

