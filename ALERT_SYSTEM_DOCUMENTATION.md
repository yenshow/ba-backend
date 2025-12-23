# 警報系統完整文檔

## 概述

本系統提供統一的多系統警報管理功能，支援多種警報類型和嚴重程度，適用於設備、環境、照明等多個系統。系統包含完整的後端 API 和前端界面，支持實時監聽和自動通知。

### 核心特性

- ✅ **多系統支持**：device, environment, lighting 等
- ✅ **狀態機管理**：pending → active → resolved/ignored
- ✅ **持久化追蹤**：錯誤狀態存儲在資料庫
- ✅ **自動觸發**：連續錯誤檢測和警報創建
- ✅ **實時監聽**：前端自動監聽新警報並顯示通知
- ✅ **向後兼容**：支持舊的 API 參數
- ✅ **智能合併**：相同來源和類型的警報自動合併顯示

---

## 警報類型 (Alert Types)

系統定義了以下 3 種警報類型：

| 類型代碼    | 類型名稱 | 說明                     | 適用場景                               |
| ----------- | -------- | ------------------------ | -------------------------------------- |
| `offline`   | 設備離線 | 設備無法連接或無回應     | 設備離線、連接超時、無法到達           |
| `error`     | 通訊錯誤 | 設備通訊過程中發生錯誤   | 通訊協議錯誤、連接被拒絕、資料讀取失敗 |
| `threshold` | 閾值超標 | 感測器數值超過設定的閾值 | CO2 濃度超標、溫度異常、濕度異常等     |

---

## 警報嚴重程度 (Alert Severity)

系統定義了以下 3 個嚴重程度等級：

| 嚴重程度 | 代碼       | 說明             | 使用場景               |
| -------- | ---------- | ---------------- | ---------------------- |
| 警告     | `warning`  | 需要關注但不緊急 | 設備離線、閾值接近上限 |
| 錯誤     | `error`    | 需要處理的問題   | 通訊錯誤、連接失敗     |
| 嚴重     | `critical` | 需要立即處理     | 長時間離線、嚴重故障   |

---

## 警報狀態 (Alert Status)

系統使用狀態機管理警報生命週期：

| 狀態   | 代碼       | 說明                         |
| ------ | ---------- | ---------------------------- |
| 待處理 | `pending`  | 剛創建，尚未激活             |
| 活躍   | `active`   | 用戶看到並需要處理           |
| 已解決 | `resolved` | 問題已修復                   |
| 已忽視 | `ignored`  | 用戶選擇忽略，不再接收新警報 |

**狀態轉換：**

```
pending → active → resolved/ignored
```

---

## 系統來源 (Alert Source)

系統支持多個來源的警報：

| 系統     | source        | source_id 對應           | source_type      |
| -------- | ------------- | ------------------------ | ---------------- |
| 設備系統 | `device`      | devices.id               | device_type_code |
| 環境系統 | `environment` | environment_locations.id | location         |
| 照明系統 | `lighting`    | lighting_areas.id        | area             |
| 空調系統 | `hvac`        | hvac_zones.id            | zone             |
| 消防系統 | `fire`        | fire_alarms.id           | alarm            |
| 安防系統 | `security`    | security_devices.id      | device           |

---

## 設備類型適配

### 目前支援的設備類型

| 設備類型 | 代碼         | 說明                           | 適配的警報類型                  |
| -------- | ------------ | ------------------------------ | ------------------------------- |
| 攝影機   | `camera`     | 影像監控、車牌辨識、人流統計   | `offline`, `error`              |
| 感測器   | `sensor`     | 感測器設備（Modbus/HTTP/MQTT） | `offline`, `error`, `threshold` |
| 控制器   | `controller` | Modbus 控制器                  | `offline`, `error`              |
| 平板     | `tablet`     | 平板電腦設備                   | `offline`, `error`              |
| 網路裝置 | `network`    | 路由器、交換器、無線基地台     | `offline`, `error`              |

---

## 自動警報觸發機制

### 1. 設備離線/通訊錯誤自動警報（後端）

**位置：** `src/server.js` + `src/services/alerts/deviceErrorTracker.js`

**觸發條件：**

- Modbus 連接超時
- Modbus 連接被拒絕
- 無法到達設備
- 連接已斷開
- RTSP 連接錯誤

**處理邏輯：**

- 自動返回 503 Service Unavailable
- 記錄簡潔的錯誤日誌（避免重複堆疊）
- **連續錯誤檢測：** 當設備連續 5 次無法連接時，自動創建 `offline` 類型的警報
- **通訊錯誤整合：** 通訊錯誤（`error` 類型）已整合到離線警報（`offline` 類型）中
- **嚴重程度自動調整：**
  - 連續 5-9 次錯誤：`warning`
  - 連續 10 次以上錯誤：`critical`
- **持久化追蹤：** 錯誤狀態存儲在 `error_tracking` 表中，服務重啟後不丟失
- **忽視檢查：** 如果警報已被忽視，不會創建新警報

**技術細節：**

- 使用資料庫追蹤每個設備的連續錯誤次數
- 當設備恢復連線時，錯誤計數會自動重置
- 每個設備只會在達到閾值時創建一次警報，避免重複創建
- 如果已有相同警報，會更新嚴重程度而非創建新警報

### 2. 前端實時監聽（前端）

**位置：** `app/composables/useAlertMonitor.ts` + `app/layouts/default.vue`

**功能：**

- 用戶登入後自動啟動警示監聽
- 每 10 秒輪詢一次新的未解決警報
- 自動顯示 Toast 通知（根據嚴重程度調整持續時間）
- 避免重複顯示相同警報
- 用戶登出時自動停止監聽

**通知顯示：**

- `critical` / `error` → 紅色錯誤 Toast（持續 10 秒）
- `warning` → 黃色警告 Toast（持續 5 秒）
- 通知訊息格式：`[系統來源]: [警示訊息]`

---

## 前端功能

### 警示紀錄頁面

**位置：** `app/pages/system/alert-log.vue`

**功能：**

- 顯示所有系統的警報列表
- 支持多種篩選條件：
  - **狀態篩選**：全部狀態、未解決、已解決、已忽視
  - **系統來源篩選**：全部系統、設備系統、環境系統、照明系統
  - **設備類型篩選**：全部設備、攝影機、感測器、控制器、平板、網路裝置
  - **時間範圍篩選**：開始日期 ~ 結束日期
- 警報合併顯示：相同來源、類型、狀態的警報自動合併，顯示次數
- 操作功能：
  - **標記已解決**：將活躍警報標記為已解決
  - **標記未解決**：管理員可將已解決的警報重新激活
  - **忽視**：將警報標記為已忽視，不再接收相同類型的新警報
- 統計資訊：顯示總計和未解決警報數量

### 共用工具函數

**位置：** `app/utils/alertUtils.ts`

提供統一的標籤和樣式函數：

- `getSourceLabel()` - 系統來源標籤
- `getTypeLabel()` - 警報類型標籤
- `getSeverityLabel()` - 嚴重程度標籤
- `getSeverityBadgeClass()` - 嚴重程度徽章樣式
- `getTypeBadgeClass()` - 類型徽章樣式

---

## API 使用範例

### 創建警報

```javascript
POST /api/alerts
Authorization: Bearer <token>
Content-Type: application/json
```

**認證要求：** 需要認證（管理員或操作員）

// 設備系統（新 API）
{
  "source": "device",
  "source_id": 1,
  "source_type": "sensor",
  "alert_type": "offline",
  "severity": "warning",
  "message": "感測器設備「展廳感測器」離線，無法讀取資料",
  "metadata": { "device_name": "展廳感測器" }
}

// 設備系統（向後兼容）
{
  "device_id": 1,
  "alert_type": "offline",
  "severity": "warning",
  "message": "感測器設備「展廳感測器」離線，無法讀取資料"
}
```

### 查詢警報

```javascript
// 查詢所有活躍警報
GET /api/alerts?status=active&limit=20&offset=0

// 查詢特定系統的警報
GET /api/alerts?source=device&status=active

// 查詢特定設備的警報（向後兼容）
GET /api/alerts?device_id=1&status=active

// 使用時間範圍篩選
GET /api/alerts?start_date=2025-01-01&end_date=2025-01-31&status=active

// 使用設備類型篩選
GET /api/alerts?source=device&device_type_code=sensor&status=active

// 向後兼容：使用 resolved/ignored 參數
GET /api/alerts?resolved=false&ignored=false
```

**認證要求：** 公開端點，無需認證

**篩選參數說明：**

- `source`: 系統來源 (device, environment, lighting 等)
- `source_id`: 來源實體 ID
- `device_id`: 設備 ID（向後兼容，等同於 `source=device&source_id=device_id`）
- `status`: 警報狀態 (pending, active, resolved, ignored)
- `resolved`: 是否已解決（向後兼容，true/false）
- `ignored`: 是否已忽視（向後兼容，true/false）
- `device_type_code`: 設備類型代碼（僅適用於 device 來源）
- `alert_type`: 警報類型 (offline, error, threshold)
- `severity`: 嚴重程度 (warning, error, critical)
- `start_date`: 開始日期（ISO 格式）
- `end_date`: 結束日期（ISO 格式）
- `limit`: 每頁數量（預設 50）
- `offset`: 偏移量（預設 0）
- `orderBy`: 排序欄位（預設 created_at）
- `order`: 排序方向（asc/desc，預設 desc）

**回應格式：**

```json
{
  "alerts": [
    {
      "id": 1,
      "source": "device",
      "source_id": 1,
      "source_type": "sensor",
      "alert_type": "offline",
      "severity": "warning",
      "message": "感測器設備「展廳感測器」離線",
      "status": "active",
      "device_name": "展廳感測器",
      "device_type_name": "感測器",
      "alert_count": 3,
      "metadata": { "device_name": "展廳感測器" },
      "created_at": "2025-01-15T10:00:00Z",
      "latest_created_at": "2025-01-15T10:05:00Z"
    }
  ],
  "total": 10,
  "limit": 50,
  "offset": 0
}
```

### 標記為已解決

```javascript
PUT /api/alerts/:deviceId/:alertType/resolve?source=device
Authorization: Bearer <token>
```

**認證要求：** 需要認證（管理員或操作員）

**說明：** 將指定來源和類型的活躍警報標記為已解決。支持多系統來源（通過 `source` 查詢參數）。如果未提供 `source` 參數，默認為 `device`（向後兼容）。

### 忽視警示

```javascript
POST /api/alerts/:deviceId/:alertType/ignore?source=device
Authorization: Bearer <token>
```

**認證要求：** 需要認證（管理員或操作員）

**說明：** 忽視功能會將相同來源和類型的活躍警報標記為已忽視。已忽視的警報仍會顯示在列表中，但會標記為「已忽視」狀態，並且不會再收到新的相同類型警報。支持多系統來源（通過 `source` 查詢參數）。如果未提供 `source` 參數，默認為 `device`（向後兼容）。

### 標記為未解決（管理員）

```javascript
PUT /api/alerts/:id/unresolve
Authorization: Bearer <token>
```

**認證要求：** 需要認證且必須是管理員

**說明：** 管理員可將已解決的警報重新標記為未解決（`active` 狀態）。

### 取得單一警示

```javascript
GET /api/alerts/:id
```

**說明：** 根據警示 ID 取得單一警示的詳細資訊，包括解決者和忽視者的用戶名稱。

**回應範例：**

```json
{
  "alert": {
    "id": 1,
    "source": "device",
    "source_id": 1,
    "source_type": "sensor",
    "alert_type": "offline",
    "severity": "warning",
    "message": "感測器設備「展廳感測器」離線",
    "status": "active",
    "metadata": { "device_name": "展廳感測器" },
    "resolved_at": null,
    "resolved_by": null,
    "resolved_by_username": null,
    "ignored_at": null,
    "ignored_by": null,
    "ignored_by_username": null,
    "created_at": "2025-01-15T10:00:00Z",
    "updated_at": "2025-01-15T10:00:00Z"
  }
}
```

### 取得未解決警報數量

```javascript
GET /api/alerts/unresolved/count?source=device&device_id=1
```

**認證要求：** 公開端點，無需認證

**說明：** 取得未解決警報（`status=active`）的數量，可用於顯示未讀警報數。

**回應格式：**

```json
{
  "count": 5
}
```

---

## 資料庫結構

### alerts 表（統一警報表）

| 欄位          | 類型           | 說明                             |
| ------------- | -------------- | -------------------------------- |
| `id`          | SERIAL         | 主鍵                             |
| `source`      | alert_source   | 系統來源（ENUM）                 |
| `source_id`   | INTEGER        | 來源實體 ID                      |
| `source_type` | VARCHAR(50)    | 來源類型（可選）                 |
| `alert_type`  | alert_type     | 警報類型（ENUM）                 |
| `severity`    | alert_severity | 嚴重程度（ENUM）                 |
| `message`     | TEXT           | 警報訊息                         |
| `status`      | alert_status   | 警報狀態（ENUM）                 |
| `metadata`    | JSONB          | 額外資訊（設備名稱、位置等）     |
| `resolved_at` | TIMESTAMP      | 解決時間                         |
| `resolved_by` | INTEGER        | 解決者用戶 ID（外鍵 → users.id） |
| `ignored_at`  | TIMESTAMP      | 忽視時間                         |
| `ignored_by`  | INTEGER        | 忽視者用戶 ID（外鍵 → users.id） |
| `created_at`  | TIMESTAMP      | 創建時間                         |
| `updated_at`  | TIMESTAMP      | 更新時間                         |

### error_tracking 表（錯誤追蹤表）

| 欄位            | 類型         | 說明             |
| --------------- | ------------ | ---------------- |
| `id`            | SERIAL       | 主鍵             |
| `source`        | alert_source | 系統來源（ENUM） |
| `source_id`     | INTEGER      | 來源實體 ID      |
| `error_count`   | INTEGER      | 連續錯誤次數     |
| `last_error_at` | TIMESTAMP    | 最後錯誤時間     |
| `alert_created` | BOOLEAN      | 是否已創建警報   |
| `created_at`    | TIMESTAMP    | 創建時間         |
| `updated_at`    | TIMESTAMP    | 更新時間         |

### ENUM 類型定義

```sql
-- 警報系統來源
CREATE TYPE alert_source AS ENUM ('device', 'environment', 'lighting', 'hvac', 'fire', 'security');

-- 警報狀態
CREATE TYPE alert_status AS ENUM ('pending', 'active', 'resolved', 'ignored');

-- 警報類型
CREATE TYPE alert_type AS ENUM ('offline', 'error', 'threshold');

-- 嚴重程度
CREATE TYPE alert_severity AS ENUM ('warning', 'error', 'critical');
```

---

## 測試工具

### 創建測試警報

```bash
npm run alerts:create-test
```

此腳本會：

1. 查找第一個啟用的感測器設備
2. 清空該設備的現有測試警報
3. 創建多個不同類型和嚴重程度的測試警報

---

## 未來擴展建議

### 1. 自動警報創建（已實現）

- ✅ **設備離線/通訊錯誤：** 當設備連續 5 次無法連接時，自動創建 `offline` 警報
- ⏳ **閾值監控：** 當感測器數值超過設定閾值時，自動創建 `threshold` 警報（待實現）

### 2. 警報升級機制（已部分實現）

- ✅ 當設備連續錯誤次數達到 10 次以上時，自動使用 `critical` 級別
- ⏳ 當 `offline` 警報持續超過 1 小時，自動升級為 `critical`（待實現）
- ⏳ 當 `threshold` 警報持續超過 30 分鐘，自動升級嚴重程度（待實現）

### 3. 通知機制

- ✅ 前端實時 Toast 通知（已實現）
- ⏳ 整合郵件通知
- ⏳ 整合簡訊通知（針對 critical 級別）
- ⏳ 整合推播通知

### 4. 設備型號特定警報

- ⏳ 為特定設備型號定義專屬的警報規則
- ⏳ 例如：某些型號的感測器可能有特定的閾值範圍

---

## 相關文檔

- [開發者指南](./ALERT_SYSTEM_DEVELOPER_GUIDE.md) - 技術實現和擴展指南
- [資料庫文檔](./docs/DATABASE_DOCUMENTATION.md) - 查看完整的資料庫結構
- [API 文檔](./docs/API_DOCUMENTATION.md) - 查看完整的 API 說明
- [架構概覽](./docs/ARCHITECTURE_OVERVIEW.md) - 查看系統架構設計
