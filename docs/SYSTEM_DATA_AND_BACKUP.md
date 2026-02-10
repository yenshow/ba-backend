# 系統資料與備份說明

## 一、架構原則

以 **location** 為查詢維度，紀錄具備區域-地點脈絡。產出**不顯示** ID，共通欄位：系統來源、區域-地點、設備配置（僅 host，如 192.168.2.204，不含 port）。

## 二、紀錄類型

| 類型 | 系統 | 資料表 | 說明 |
|------|------|--------|------|
| 日常記錄 | 環境品質 | environment_readings | 感測器讀數 |
| 日常記錄 | 人流統計 | people_counting_logs | 刷卡記錄（同步自外部） |
| 異常記錄 | 照明、環境閾值等 | alerts | 事件驅動 |

## 三、備份

- **執行**：定時（預設 24 小時）、備份後刪除 DB 過期資料、刪除舊檔
- **手動執行**：`npm run backup:run` 一次備份三種資料
- **格式**：CSV（繁中、區域-地點、設備配置）
- **檔名**：依資料日期（非執行日），如資料為 1/10 則檔名 `people_counting_logs_2026-01-10.csv`
- **目錄**：`backups/environment_readings/`、`backups/alerts/`、`backups/people_counting/`

### 配置

| 環境變數 | 說明 | 預設 |
|----------|------|------|
| BACKUP_RETENTION_DAYS | 資料庫保留天數 | 30 |
| BACKUP_FILE_RETENTION_DAYS | 備份檔保留天數 | 365 |
| BACKUP_SCHEDULER_ENABLED | 啟用排程 | true |
| BACKUP_COMPRESSION_ENABLED | 壓縮 | false |

### CSV 欄位

| 類型 | 共通欄位 | 專屬欄位 |
|------|----------|----------|
| environment_readings | 系統來源、區域-地點、設備配置、記錄時間 | 溫度、濕度、PM2.5 等 |
| alerts | 同上 + 設備類型 | 類型與程度、狀態、訊息、創建/更新/忽視時間、忽視者 |
| people_counting | 同上 | 當日進場/出場人數、人員ID、刷卡時間、出入口設備名稱、單位、方向 |

## 四、相關檔案

- `src/services/backup/backupScheduler.js` - 定時備份
- `src/services/backup/*ReportFormat.js` - 各類型 CSV 格式
- `src/services/systems/environmentReadingsService.js` - 環境讀數寫入
