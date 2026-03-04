# 系統資料與備份說明

## 一、架構原則

以 **location** 為查詢維度，紀錄具備區域-地點脈絡。產出**不顯示** ID。環境品質報表／備份以**區域-地點**為記錄依據，**不顯示設備配置、不顯示系統來源**；欄位：區域-地點、記錄時間、數值欄位（其他系統若需設備脈絡則保留設備配置／系統來源）。

## 二、紀錄類型

| 類型 | 系統 | 資料表 | 說明 |
|------|------|--------|------|
| 日常記錄 | 環境品質 | environment_readings | 感測器讀數 |
| 日常記錄 | 人流統計 | people_counting_logs | 刷卡記錄（同步自外部） |
| 日常記錄 | 車輛進出 | vehicle_passageway_logs | 過車記錄（同步自外部 vehiclebiz） |
| 異常記錄 | 照明、環境閾值等 | alerts | 事件驅動 |

## 三、備份

- **執行**：定時（預設 24 小時）、備份後刪除 DB 過期資料、刪除舊檔
- **手動執行**：`npm run backup:run` 一次備份三種資料
- **格式**：CSV（繁中、區域-地點；環境品質不顯示設備配置）
- **檔名**：依資料日期（非執行日），如資料為 1/10 則檔名 `people_counting_logs_2026-01-10.csv`
- **目錄**：`backups/environment_readings/`、`backups/alerts/`、`backups/people_counting/`、`backups/vehicle_access/`

### 配置

| 環境變數 | 說明 | 預設 |
|----------|------|------|
| BACKUP_RETENTION_DAYS | 資料庫保留天數 | 30 |
| BACKUP_FILE_RETENTION_DAYS | 備份檔保留天數 | 365 |
| BACKUP_SCHEDULER_ENABLED | 啟用排程 | true |
| BACKUP_SCHEDULER_INTERVAL | 排程間隔（毫秒） | 86400000（24 小時） |
| BACKUP_COMPRESSION_ENABLED | 壓縮 | false |

### CSV 欄位

| 類型 | 共通欄位 | 專屬欄位 |
|------|----------|----------|
| environment_readings | 區域-地點、記錄時間 | 溫度、濕度、PM2.5 等（數值依參數四捨五入至小數一位） |
| alerts | 同上 + 設備類型 | 類型與程度、狀態、訊息、創建/更新/忽視時間、忽視者 |
| people_counting | 同上 | 當日進場/出場人數、人員ID、刷卡時間、出入口設備名稱、單位、方向 |
| vehicle_access | 同上 | 進出統計、群組統計、過車紀錄（與前端完整報表同格式） |

## 四、做法 C：拉長 DB 保留期（支援「年」趨勢）

若前端環境品質頁面的「年」趨勢需從 DB 查詢完整 12 個月資料，可將 `BACKUP_RETENTION_DAYS=365`。

### 影響評估

| 項目 | 30 天（預設） | 365 天 |
|------|---------------|--------|
| 前端「年」趨勢 | 僅能顯示約 30 天 | 可顯示完整 12 個月 |
| DB `environment_readings` 筆數 | 約 1.3 萬筆（2 地點、15 秒/筆） | 約 15 萬筆 |
| DB 佔用空間（估） | 約 3 MB | 約 30–50 MB |
| 備份檔 | 每日備份當天過期資料，單日 CSV 約 50 KB | 同左（備份邏輯不變，仍為每日匯出當天到期資料） |
| 備份目錄總量 | 365 天 × 3 類型，約 50 MB | 同左（`BACKUP_FILE_RETENTION_DAYS` 控制） |
| 查詢效能 | 較佳 | 仍可接受（有 `idx_environment_readings_recorded_at`） |

### 考量點

- **查詢 limit**：`environmentService.getReadings` 預設 `limit=1000`。年度趨勢建議前端以「每日彙總」請求（約 365 筆），或傳入較大 `limit`。
- **alerts / people_counting_logs**：兩者為事件型資料，筆數遠少於 `environment_readings`，拉長保留期影響較小。
- **建議**：若主要為支援年度趨勢，可僅拉長 `environment_readings` 保留期；目前設計為三表共用 `BACKUP_RETENTION_DAYS`，若需分表設定則需改程式。

### 設定方式

在 `.env` 加入或修改：

```
BACKUP_RETENTION_DAYS=365
```

重啟伺服器後生效，無需改程式。

## 五、相關檔案

- `src/services/backup/backupScheduler.js` - 定時備份
- `src/services/backup/*ReportFormat.js` - 各類型 CSV 格式
- `src/services/systems/environmentReadingsService.js` - 環境讀數寫入
- `src/services/systems/peopleCountingSyncService.js` - 人流記錄同步
- `src/services/systems/vehicleAccessSyncService.js` - 車輛進出過車記錄同步
