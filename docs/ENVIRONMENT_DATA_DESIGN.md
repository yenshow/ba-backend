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

### 1.1 數值換算與顯示一致性（以設備型號管理為準）

目標：**同一個參數在「環境品質頁面（即時）」與「完整報表/匯出（歷史）」顯示必須一致**，避免倍率/單位/四捨五入規則分散在不同地方造成不一致。

#### 單一資料來源（Single Source of Truth）

- **換算定義來源**：由「設備管理 → 感測器型號管理」在 `device_models.config.sensorParameters[].modbusConfig.transform` 定義。
- **前端即時顯示**：環境頁面讀取 Modbus 原始值後，**先套用 `transform`** 再顯示。
- **後端歷史/報表**：後端監控寫入 `environment_readings` 時，會依設備型號的 `sensorParameters.modbusConfig.transform` 建立換算公式並套用後寫入；報表/彙總皆以此資料為準。

> 補充：若設備層級（`devices.config.logging.values`）有自訂換算，會優先於型號設定；若要全系統一致，建議以「型號管理」集中維護並避免各設備各自覆蓋。

#### transform 格式約定（建議）

`transform` 使用「簡化格式」，前後端都支援：

- `"/ 10"`：例如暫存器值 250 → 顯示 25.0
- `"* 0.1"`：例如暫存器值 250 → 顯示 25.0
- `"+ 5"` / `"- 1"`：位移修正
- `"value * 0.1 + 2"`：複合公式（可用 `value` 代表原始值）
- `"1"`（純數字）：視為 `value - 1`（向後相容用法；不建議新設定使用）

#### 參數 key、單位與小數位（預設）

> 目前前端顯示與報表格式化採用下列預設（若未來要完全由型號管理決定，可擴充型號配置加上 unit/digits）。

| 參數 key | 顯示名稱 | 單位 | 建議小數位 |
|---|---|---|---|
| `pm25` | PM2.5 | µg/m³ | 0 |
| `pm10` | PM10 | µg/m³ | 0 |
| `co2` | CO2 | ppm | 0 |
| `noise` | 噪音值 | dB | 0 |
| `humidity` | 濕度 | % | 1 |
| `temperature` | 溫度 | °C | 1 |
| `wind` | 風速 | m/s | 1 |
| `tvoc` | TVOC | ppm | 1 |
| `hcho` | HCHO | ppm | 1 |

#### 四捨五入規則

- **後端寫入/彙總**：目前統一到小數 1 位（便於趨勢/報表一致）。
- **前端顯示**：依「參數小數位」規則格式化，避免同一參數在不同元件用不同的 `Math.round()`/`toFixed()`。

### 1.2 進站載入與總覽（所有地點都有資料）

- **後端 WebSocket**：監控依「地點 × 設備」逐台讀取並推送；同一地點多台設備會各推一筆（每筆為該設備的參數），前端依 `locationId` 合併到該地點的顯示。
- **前端進站**：載入區域後會（1）對**選中地點**呼叫 `loadLocationSensorData`（主面板）、（2）對**其餘有設備的地點**呼叫 `loadLocationSensorDataForOverview`（總覽）、（3）啟動輪詢且 `immediate: true`，進站即跑一輪。因此選中地點與總覽各地點在進站時都會有資料來源。
- **並行讀取**：進站與輪詢皆以 `Promise.allSettled` **並行**執行「選中地點」與「所有總覽地點」的讀取，總覽（含大門口等）不會等選中地點讀完才開始，所有地點的資料會一併更新。

### 1.3 同一地點多設備：寫入與報表整合

- **寫入**：後端依「地點 × 設備」每 5 分鐘各寫一筆 raw 至 `environment_readings`（每筆的 `data` 僅含該設備提供的參數，例如 A 設備 pm25/pm10/…、B 設備 wind）。
- **報表「詳細資料」**：前端呼叫 raw API 會拿到同一地點多筆（每設備一筆）。報表以 **5 分鐘區間** 合併同一地點的多筆讀數（同參數取平均），故同一列會呈現該區間內所有設備提供的參數，不會出現「只有風速」等單一設備欄位。

### 1.4 常見顯示問題與 Network 說明

- **「有抓取資料但頁面沒顯示」**  
  - **總覽某地點整塊空白**：多為該地點的感測器資料在 Map 裡用錯 key（例如 `location.id` 數字與字串 `"63"` 不一致）。前端已改為 Map key 一律字串、`getLocationId` 一律回傳字串，並同時寫入資料庫 ID 與合成 ID（區域名-地點名），總覽應能對應到。  
  - **總覽某地點只有部分參數有值（例如大門口只顯示風速）**：一地點多設備時，若某台設備讀取失敗，舊邏輯會用 `null` 覆蓋已寫入值。前端已改為總覽**僅在讀取成功時寫入**，每輪先清空該地點再合併本輪成功值，避免被覆蓋。  
  - **某參數一直顯示 `—`（例如噪音值）**：表示該地點目前沒有該參數的數值（設備型號未設定該參數的 Modbus、或該參數未啟用、或讀取失敗）。Network 的 `holding-registers` 雖 200，若回傳的暫存器未對應到該參數或 transform 錯誤，前端仍會顯示 `—`。

- **Network 裡的 `errors` 請求**  
  - 若看到 `DELETE .../environment/systems/:id/errors` 且狀態 **200 OK**，代表前端在**清除該地點的錯誤狀態**（例如感測器恢復連線後清除錯誤），不是請求失敗。  
  - `holding-registers` 旁若有警告圖示，多為 CORS／混合內容等非致命提示，不一定是資料沒抓到；若該參數仍顯示 `—`，請檢查設備型號管理與地點參數啟用。

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
