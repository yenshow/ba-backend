# 備份系統完整文檔

## 概述

本系統採用**統一備份服務架構**，提供三種備份機制用於保護和管理資料庫中的歷史資料：

1. **主要資料備份腳本** - 手動備份設備資料日誌和警報
2. **警報自動清理服務** - 自動備份並清理過期警報
3. **資料庫清理腳本** - 在資料庫結構清理前備份資料

所有備份功能都基於統一的備份服務核心（`src/services/backup/`），確保功能一致性和可維護性。

---

## 統一備份服務架構

### 核心架構

```
src/services/backup/
├── backupConfig.js      # 備份配置管理（集中管理所有配置）
├── backupFormats.js     # 備份格式處理（JSON/CSV，支援壓縮）
├── backupService.js     # 核心備份服務（統一 API）
└── backupScheduler.js   # 定時備份任務管理
```

### 主要特性

- ✅ **統一 API** - 所有備份操作使用相同的介面
- ✅ **集中配置** - 所有配置集中在 `backupConfig.js`
- ✅ **多格式支援** - 支援 JSON 和 CSV 格式
- ✅ **壓縮支援** - 可選的 gzip 壓縮
- ✅ **統一命名** - 一致的檔案命名規則
- ✅ **自動清理** - 自動刪除超過保留期的備份檔案
- ✅ **錯誤處理** - 統一的錯誤處理機制

### 配置管理

所有配置集中在 `src/services/backup/backupConfig.js`，支援環境變數覆蓋：

| 環境變數                                 | 說明                        | 預設值             |
| ---------------------------------------- | --------------------------- | ------------------ |
| `BACKUP_DB_RETENTION_DAYS_ALERTS`        | 警報資料庫保留天數          | 30                 |
| `BACKUP_DB_RETENTION_DAYS_DEVICE_LOGS`   | 設備日誌資料庫保留天數      | 30                 |
| `BACKUP_FILE_RETENTION_DAYS_ALERTS`      | 警報備份檔案保留天數        | 365                |
| `BACKUP_FILE_RETENTION_DAYS_DEVICE_LOGS` | 設備日誌備份檔案保留天數    | 365                |
| `BACKUP_COMPRESSION_ENABLED`             | 是否啟用壓縮                | false              |
| `BACKUP_SCHEDULER_ALERTS_ENABLED`        | 是否啟用定時任務            | true               |
| `BACKUP_SCHEDULER_ALERTS_INTERVAL`       | 定時任務執行間隔（毫秒）    | 86400000 (24 小時) |
| `BACKUP_NAMING_STRATEGY`                 | 命名策略（timestamp/daily） | timestamp          |

---

## 1. 主要資料備份腳本 (`scripts/backupData.js`)

### 功能說明

使用統一備份服務進行手動備份，支援備份舊資料並可選刪除。

### 備份內容

- **`device_data_logs`** - 備份指定天數前的設備資料日誌
- **`alerts`** - 備份已解決且超過指定天數的警報

### 備份格式

- **JSON 格式** - 完整資料結構，易於讀取和還原
- **CSV 格式** - 表格格式，易於在 Excel 等工具中查看

### 檔案命名規則

- JSON: `{tableName}_{YYYYMMDD}_{HHMMSS}.json`
- CSV: `{tableName}_{YYYYMMDD}_{HHMMSS}.csv`
- 範例：`device_data_logs_20240115_143022.json`

### 使用方式

#### 基本命令

```bash
# 只備份，不刪除資料（預設 30 天前）
npm run db:backup

# 備份後刪除資料（預設 30 天前）
npm run db:cleanup

# 自訂保留天數（例如：90 天）
node scripts/backupData.js --days 90

# 只備份不刪除，自訂天數
node scripts/backupData.js --days 90 --backup-only

# 顯示說明
node scripts/backupData.js --help
```

#### 命令參數

| 參數            | 說明                             | 預設值 |
| --------------- | -------------------------------- | ------ |
| `--days <數字>` | 保留天數（備份此天數之前的資料） | 30     |
| `--backup-only` | 只備份，不刪除資料               | false  |
| `--help, -h`    | 顯示說明                         | -      |

### 備份位置

```
backups/
├── device_logs/                    # 設備日誌備份
│   ├── json/
│   │   └── device_data_logs_{timestamp}.json
│   └── csv/
│       └── device_data_logs_{timestamp}.csv
└── alerts/                          # 警報備份
    ├── json/
    │   └── alerts_{timestamp}.json
    └── csv/
        └── alerts_{timestamp}.csv
```

### 執行流程

1. 測試資料庫連線
2. 使用統一備份服務查詢需要備份的資料
3. 匯出為 JSON 和 CSV 格式（根據配置）
4. 如果未使用 `--backup-only`，則刪除已備份的資料
5. 顯示備份統計資訊

### 實作方式

腳本使用統一備份服務：

```javascript
const backupService = require("../src/services/backup/backupService");
const backupConfig = require("../src/services/backup/backupConfig");

// 使用統一服務備份多個表
const results = await backupService.backupMultiple({
  tables: [
    {
      tableName: "device_data_logs",
      query: "SELECT * FROM device_data_logs WHERE recorded_at < $1",
      params: [beforeDate],
      deleteQuery: "DELETE FROM device_data_logs WHERE recorded_at < $1",
      deleteParams: [beforeDate],
      category: "deviceLogs",
      formats: backupConfig.formats.deviceDataLogs,
      deleteAfterBackup: !backupOnly,
    },
    // ...
  ],
});
```

---

## 2. 警報自動清理服務 (`src/services/alerts/alertCleanupService.js`)

### 功能說明

使用統一備份服務進行自動備份並清理過期警報，在伺服器啟動時自動啟動定時任務。

### 備份內容

- **`alerts`** - 僅備份已解決（`status = 'resolved'`）且超過保留期的警報

### 備份格式

- **JSON 格式** - 完整警報資料結構
- **CSV 格式** - 表格格式（根據配置）

### 檔案命名規則

- `alerts_archive_{YYYYMMDD}.json` / `.csv`
- 同一天的備份會合併到同一個檔案（daily 策略）

### 配置參數

| 參數                    | 說明                               | 預設值  |
| ----------------------- | ---------------------------------- | ------- |
| `DB_RETENTION_DAYS`     | 資料庫保留天數（前端可追溯的時間） | 30      |
| `BACKUP_RETENTION_DAYS` | 備份檔案保留天數                   | 365     |
| `CLEANUP_INTERVAL`      | 清理任務執行間隔                   | 24 小時 |

### 執行時機

- **自動執行** - 伺服器啟動時自動啟動定時任務
- **執行頻率** - 每 24 小時執行一次（可配置）
- **手動執行** - 可透過模組匯出的函數手動執行

### 備份位置

```
backups/alerts/
├── json/
│   └── alerts_archive_YYYYMMDD.json
└── csv/
    └── alerts_archive_YYYYMMDD.csv
```

### 執行流程

1. 查詢超過保留期的已解決警報
2. 使用統一備份服務備份資料（daily 合併策略）
3. 從資料庫刪除已備份的警報
4. 刪除超過保留期的舊備份檔案

### 實作方式

服務使用統一備份排程器：

```javascript
const backupScheduler = require("../backup/backupScheduler");
const backupConfig = require("../backup/backupConfig");

// 執行清理（使用統一服務）
async function runCleanup() {
  return await backupScheduler.runAlertsCleanup();
}
```

---

## 3. 資料庫清理腳本 (`scripts/cleanupDatabase.js`)

### 功能說明

在資料庫結構清理前備份資料，作為安全措施。可使用統一備份服務進行備份。

### 備份內容

- 備份要移除的表資料（例如：`modbus_device_types`、`modbus_device_models` 等）

### 備份格式

- **JSON 格式** - 完整表資料結構

### 檔案命名規則

- `{tableName}_{YYYYMMDD}_{HHMMSS}.json`

### 使用方式

```bash
# 執行資料庫清理（會自動備份）
node scripts/cleanupDatabase.js
```

### 備份位置

```
backups/cleanup/
└── {tableName}_{timestamp}.json
```

### 執行流程

1. 測試資料庫連線
2. 使用統一備份服務備份要移除的表資料
3. 移除外鍵約束
4. 更新外鍵約束
5. 移除多餘的表
6. 清理 devices 表欄位
7. 顯示備份統計資訊

---

## 備份目錄結構

```
backups/
├── alerts/                          # 警報自動清理服務的備份
│   ├── json/
│   │   └── alerts_archive_YYYYMMDD.json
│   └── csv/
│       └── alerts_archive_YYYYMMDD.csv
├── device_logs/                     # 主要備份腳本的設備日誌備份
│   ├── json/
│   │   └── device_data_logs_YYYYMMDD_HHMMSS.json
│   └── csv/
│       └── device_data_logs_YYYYMMDD_HHMMSS.csv
├── cleanup/                         # 資料庫清理腳本的備份
│   └── {tableName}_YYYYMMDD_HHMMSS.json
└── alerts/                          # 主要備份腳本的警報備份（與自動清理共用目錄）
    ├── json/
    │   └── alerts_YYYYMMDD_HHMMSS.json
    └── csv/
        └── alerts_YYYYMMDD_HHMMSS.csv
```

---

## 統一備份服務 API

### 備份單一表

```javascript
const backupService = require("./src/services/backup/backupService");

const result = await backupService.backupTable({
  tableName: "alerts",
  query: "SELECT * FROM alerts WHERE status = $1 AND resolved_at < $2",
  params: ["resolved", beforeDate],
  deleteQuery: "DELETE FROM alerts WHERE status = $1 AND resolved_at < $2",
  deleteParams: ["resolved", beforeDate],
  category: "alerts", // 備份類別
  formats: ["json", "csv"], // 備份格式
  deleteAfterBackup: true, // 是否刪除資料
  mergeStrategy: "daily", // 合併策略：'timestamp' | 'daily'
  compress: false, // 是否壓縮
});
```

### 備份多個表

```javascript
const results = await backupService.backupMultiple({
  tables: [
    {
      tableName: "device_data_logs",
      query: "SELECT * FROM device_data_logs WHERE recorded_at < $1",
      params: [beforeDate],
      deleteQuery: "DELETE FROM device_data_logs WHERE recorded_at < $1",
      deleteParams: [beforeDate],
      category: "deviceLogs",
      formats: ["json", "csv"],
      deleteAfterBackup: true,
    },
    // ... 更多表
  ],
  compress: false,
});
```

### 刪除舊備份檔案

```javascript
const deletedCount = await backupService.deleteOldBackups(
  "alerts", // 備份類別
  365 // 保留天數（可選，使用配置預設值）
);
```

### 驗證備份檔案

```javascript
const isValid = await backupService.validateBackup(
  "backups/alerts/json/alerts_20240115_143022.json"
);
```

---

## 整合點

### 伺服器啟動時自動啟動

在 `src/server.js` 中，警報自動清理服務會在伺服器啟動時自動啟動：

```javascript
const alertCleanupService = require("./services/alerts/alertCleanupService");

// 啟動警報自動清理服務（使用統一備份服務）
alertCleanupService.startCleanupScheduler();
console.log("✅ 警報自動清理服務已啟用");
```

---

## 比較表

| 特性         | 主要備份腳本                                | 警報自動清理服務  | 資料庫清理腳本     |
| ------------ | ------------------------------------------- | ----------------- | ------------------ |
| **執行方式** | 手動                                        | 自動（定時）      | 手動               |
| **備份內容** | device_data_logs + alerts                   | alerts only       | 指定表             |
| **備份格式** | JSON + CSV                                  | JSON + CSV        | JSON               |
| **刪除資料** | 可選（預設是）                              | 是                | 否（僅結構）       |
| **保留天數** | 可自訂（預設 30）                           | 固定 30 天        | 不適用             |
| **備份位置** | `backups/device_logs/`<br>`backups/alerts/` | `backups/alerts/` | `backups/cleanup/` |
| **檔案命名** | 時間戳記                                    | 日期（合併）      | 時間戳記           |
| **合併策略** | timestamp                                   | daily             | timestamp          |

---

## 注意事項

### 1. 備份目錄

- 所有備份目錄會在首次執行時自動建立
- 如果目錄不存在，統一備份服務會自動創建
- 多種格式時會自動建立格式子目錄（json/、csv/）

### 2. 自動清理服務

- 僅處理警報（`alerts` 表），不處理 `device_data_logs`
- 同一天的備份會合併到同一個檔案（daily 策略）
- 備份檔案保留 365 天後自動刪除
- 使用統一備份服務，支援 JSON 和 CSV 格式

### 3. 主要備份腳本

- 支援 `--backup-only` 模式，可只備份不刪除
- 預設會刪除已備份的資料（除非使用 `--backup-only`）
- 同時產生 JSON 和 CSV 兩種格式
- 使用統一備份服務，確保功能一致性

### 4. 資料庫清理腳本

- 僅在執行資料庫結構清理時使用
- 作為安全措施，備份要移除的表資料
- 不會自動刪除備份檔案
- 建議使用統一備份服務進行備份

### 5. 資料庫連線

- 所有備份腳本都會先測試資料庫連線
- 連線失敗時會終止執行並顯示錯誤訊息
- 使用 PostgreSQL 參數化查詢（$1, $2, ...）

### 6. 錯誤處理

- 所有備份操作都有錯誤處理機制
- 錯誤會記錄到控制台
- 備份失敗時不會刪除資料
- 統一的錯誤處理確保一致性

### 7. 壓縮支援

- 可透過環境變數 `BACKUP_COMPRESSION_ENABLED=true` 啟用
- 壓縮檔案會自動加上 `.gz` 副檔名
- 支援 JSON 和 CSV 格式壓縮

---

## 建議使用場景

### 定期備份（建議）

```bash
# 每週執行一次，備份 90 天前的資料，只備份不刪除
node scripts/backupData.js --days 90 --backup-only
```

### 清理舊資料

```bash
# 每月執行一次，備份並刪除 30 天前的資料
npm run db:cleanup
```

### 緊急備份

```bash
# 立即備份所有舊資料（不刪除）
npm run db:backup
```

---

## 還原資料

### JSON 格式還原

備份的 JSON 檔案可以直接用於還原資料：

```javascript
const fs = require("fs");
const db = require("./src/database/db");
const backupData = JSON.parse(
  fs.readFileSync("backups/alerts/json/alerts_20240101_120000.json", "utf8")
);

// 還原資料（範例）
for (const record of backupData) {
  await db.query("INSERT INTO alerts ...", [
    /* values */
  ]);
}
```

### CSV 格式還原

CSV 檔案可以使用資料庫工具（如 pgAdmin）或腳本匯入。

### 壓縮檔案還原

如果備份檔案是壓縮的（`.gz`），需要先解壓縮：

```javascript
const zlib = require("zlib");
const fs = require("fs");

const compressed = fs.readFileSync(
  "backups/alerts/json/alerts_20240101_120000.json.gz"
);
const decompressed = zlib.gunzipSync(compressed);
const backupData = JSON.parse(decompressed.toString("utf8"));
```

---

## 維護建議

1. **定期檢查備份目錄** - 確保備份檔案正常產生
2. **監控磁碟空間** - 備份檔案會佔用空間，定期清理舊備份
3. **測試還原流程** - 定期測試備份檔案的還原功能
4. **記錄備份日誌** - 建議記錄每次備份的執行時間和結果
5. **異地備份** - 考慮將重要備份檔案複製到其他位置
6. **配置管理** - 透過環境變數統一管理配置，避免硬編碼

---

## 相關檔案

### 統一備份服務核心

- `src/services/backup/backupConfig.js` - 備份配置管理
- `src/services/backup/backupFormats.js` - 備份格式處理
- `src/services/backup/backupService.js` - 核心備份服務
- `src/services/backup/backupScheduler.js` - 定時備份任務
- `src/services/backup/README.md` - 統一備份服務說明

### 備份腳本和服務

- `scripts/backupData.js` - 主要資料備份腳本（已重構）
- `src/services/alerts/alertCleanupService.js` - 警報自動清理服務（已重構）
- `scripts/cleanupDatabase.js` - 資料庫清理腳本

### 系統整合

- `src/server.js` - 伺服器主程式（整合自動清理服務）
- `package.json` - NPM 腳本定義

---

## 更新記錄

- **初始版本** - 包含三種備份機制的基本功能
- **自動清理服務** - 在伺服器啟動時自動啟動
- **統一備份服務重構** (2024) - 完成統一備份服務架構重構
  - 建立統一備份服務核心（`src/services/backup/`）
  - 重構所有備份腳本和服務使用統一服務
  - 統一配置管理、格式處理、命名規則
  - 支援壓縮、自動清理、備份驗證等功能
  - 減少程式碼重複，提高可維護性
