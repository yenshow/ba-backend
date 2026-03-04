# 環境品質資料系統設計

寫入週期、彙總表（時／日／月）、趨勢與完整報表約定，以及與既有備份系統的整合。

---

## 一、核心約定

| 項目 | 說明 |
|------|------|
| **即時** | 前端每 30 秒刷新感測器資料；後端每 5 分鐘寫入一筆原始讀數至 `environment_readings`。 |
| **彙總** | 時／日／月彙總寫入 `environment_readings_aggregated`，供趨勢圖與報表使用。 |
| **趨勢** | 日→每小時平均、週／月→每日平均、年→每月平均。 |
| **報表** | 今天／昨天：每小時平均表 ＋ 詳細（5 分鐘）表；本週／上週：每日平均表 ＋ 每小時平均詳細表。 |
| **警報** | 依當前讀數觸發／解除，不讀歷史或彙總。 |

---

## 二、寫入週期

- **後端 raw**：每 5 分鐘一筆寫入 `environment_readings`（監控可維持每 15 秒讀感測器，僅寫入節點改為 5 分鐘）。單一地點每日約 288 筆。
- **後端彙總**：排程寫入 `environment_readings_aggregated`  
  - **hour**：每小時寫入「上一小時」的區間平均（由該小時內 raw 計算）。  
  - **day**：每日寫入「昨日」的區間平均。  
  - **month**：每月寫入「上月」的區間平均。
- **前端**：每 30 秒取得即時值更新儀表；趨勢與報表改為呼叫彙總 API 或 raw API（見下）。

---

## 三、彙總維度與表結構

趨勢與報表對應關係：

| 前端 | 彙總單位 | bucket | 筆數量級 |
|------|----------|--------|----------|
| 日 | 每小時 | hour | 24 |
| 週／月 | 每日 | day | 7～30 |
| 年 | 每月 | month | 12 |

**彙總表建議**：

```sql
CREATE TABLE environment_readings_aggregated (
  id BIGSERIAL PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  bucket_type VARCHAR(10) NOT NULL,  -- 'hour' | 'day' | 'month'
  bucket_at TIMESTAMP NOT NULL,     -- 區間起點（小時 0 分 / 日 0 時 / 月 1 日）
  data JSONB NOT NULL,              -- 各參數平均 { temperature, humidity, pm25, ... }
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(location_id, bucket_type, bucket_at)
);
CREATE INDEX idx_env_agg_location_bucket ON environment_readings_aggregated(location_id, bucket_type, bucket_at);
```

---

## 四、備份與刪除（與既有備份系統一致）

與現有備份排程相同：以 `BACKUP_RETENTION_DAYS` 計算 `beforeDate`，過期資料**先備份再刪除**。彙總表比照辦理，不另訂保留天數。

### 4.1 原始表 `environment_readings`

- **維持現狀**：`recorded_at < beforeDate` 先匯出 CSV 再刪除；目錄與格式沿用 `environmentReadingsReportFormat`。

### 4.2 彙總表 `environment_readings_aggregated`

- **同一套邏輯**：`bucket_at < beforeDate` 的彙總列先備份（匯出 CSV 至例如 `backups/environment_readings_aggregated/`）再刪除；保留天數與 raw 相同，由 `BACKUP_RETENTION_DAYS` 決定。
- 備份檔保留依現有 `BACKUP_FILE_RETENTION_DAYS` 管理。

### 4.3 執行順序

1. Raw：過期資料備份 → 刪除。
2. 彙總：過期資料備份 → 刪除（同一 `beforeDate`）。
3. 彙總寫入排程：計算並寫入「上一小時」hour、「昨日」day、「上月」month（可與備份排程同日或獨立每小時／每日執行）。

---

## 五、完整報表與 API

- **記錄依據**：以**區域-地點**為記錄依據，報表與備份**不顯示設備配置**（地點可對應多台感測器）。
- **欄位**：區域-地點、記錄時間（或區間起點）、數值欄位（CO2、HCHO、PM10、PM2.5、TVOC、風速、噪音值、濕度、溫度等）。
- **今天／昨天**：表格 1 用彙總 API（`bucket=hour`）；表格 2 用 raw API（`GET /readings/:locationId?startTime=&endTime=`）。
- **本週／上週**：表格 1 用彙總 API（`bucket=day`）；表格 2 用彙總 API（`bucket=hour`）作為「每小時平均的詳細資料」。
- **趨勢圖**：前端依 日／週／月／年 請求 `GET /readings/:locationId/aggregated?bucket=hour|day|month&startTime=&endTime=`，時間區間以 UTC 傳遞。
- **匯出**：針對**當天所有記錄**匯出（不區分每小時平均或詳細資料，可參考人流統計等單一匯出方式）；與後端備份欄位對齊（`environmentReadingsReportFormat`）：區域-地點、記錄時間、數值欄位。
- **數值精度**：平均與原始數值皆依參數設定四捨五入至**小數一位**（與儲存／趨勢一致）。

---

## 六、流程摘要

```
感測器 → 後端每 5 分鐘寫入 environment_readings
       → 排程寫入 environment_readings_aggregated (hour / day / month)
       → WebSocket 推送即時值（可維持較高頻率）
前端：每 30 秒刷新 → 儀表；趨勢／報表 → aggregated 或 raw API

備份：raw 與彙總表皆以 BACKUP_RETENTION_DAYS 計算 beforeDate，先備份再刪除。
```

---

## 七、相關檔案與設定

| 項目 | 路徑或變數 |
|------|------------|
| 寫入 raw | `src/services/systems/environmentReadingsService.js`、`src/services/monitoring/environmentMonitor.js`（改為 5 分鐘寫入） |
| 彙總排程與寫入 | 新增（例如 `src/services/systems/environmentAggregationService.js` 或於 backup 模組擴充） |
| 彙總查詢 | `src/services/systems/environmentService.js`（新增 getReadingsAggregated） |
| 路由 | `src/routes/environmentRoutes.js`（新增 GET /readings/:locationId/aggregated） |
| 備份與刪除 | `src/services/backup/backupScheduler.js`（raw 維持；新增彙總表備份＋刪除，同一 beforeDate） |
| 備份格式 | `src/services/backup/environmentReadingsReportFormat.js`；彙總備份可共用或另建 format |
| 資料表 | `src/database/initSchema.js`（environment_readings；新增 environment_readings_aggregated） |
| 保留天數 | `BACKUP_RETENTION_DAYS`（raw 與彙總共用） |

前端：環境頁與趨勢 `SensorTrendChart` 改為呼叫 aggregated API；完整報表 `EnvironmentSimulation` 依今天／昨天／本週／上週顯示雙表並支援匯出。
