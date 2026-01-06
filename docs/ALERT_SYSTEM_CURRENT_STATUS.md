# 警報系統 API 文檔（前端開發參考）

**最後更新**：2025-01-06  
**適用版本**：後端 v1.0+

---

## 📋 目錄

1. [系統概覽](#系統概覽)
2. [API 端點](#api-端點)
3. [WebSocket 事件](#websocket-事件)
4. [監控系統](#監控系統)
5. [數據結構](#數據結構)
6. [使用範例](#使用範例)

---

## 系統概覽

### 核心概念

- **來源（Source）**：警報的系統來源（device, environment, lighting, hvac, fire, security）
- **警報類型（Alert Type）**：offline（離線）、error（錯誤）、threshold（閾值）
- **嚴重程度（Severity）**：warning（警告）、error（錯誤）、critical（嚴重）
- **狀態（Status）**：active（活動中）、resolved（已解決）、ignored（已忽視）

### 系統特性

- ✅ **系統自動創建與解決**：所有警報由系統監控任務自動產生和解決，用戶無法手動操作
- ✅ **規則驅動**：通過配置 `alert_rules` 規則來控制警報的產生條件
- ✅ 自動合併相同來源和類型的 active 警報
- ✅ 嚴重程度自動升級（只升級不降級）
- ✅ 自動清理舊警報（超過 30 天的已解決警報）
- ✅ WebSocket 即時通知

---

## API 端點

### 基礎路徑

```
/api/alerts
```

### 1. 取得警報列表

**GET** `/api/alerts`

**查詢參數**：

| 參數            | 類型    | 說明                                   | 範例                                |
| --------------- | ------- | -------------------------------------- | ----------------------------------- |
| `source`        | string  | 系統來源                               | `device`, `environment`, `lighting` |
| `source_id`     | number  | 來源 ID                                | `1`, `2`                            |
| `device_id`     | number  | 設備 ID（向後兼容）                    | `1`, `2`                            |
| `alert_type`    | string  | 警報類型                               | `offline`, `error`, `threshold`     |
| `severity`      | string  | 嚴重程度                               | `warning`, `error`, `critical`      |
| `status`        | string  | 狀態                                   | `active`, `resolved`, `ignored`     |
| `resolved`      | boolean | 是否已解決（向後兼容）                 | `true`, `false`                     |
| `ignored`       | boolean | 是否已忽視（向後兼容）                 | `true`, `false`                     |
| `start_date`    | string  | 開始日期（ISO 8601）                   | `2025-01-01T00:00:00Z`              |
| `end_date`      | string  | 結束日期（ISO 8601）                   | `2025-01-31T23:59:59Z`              |
| `updated_after` | string  | 增量查詢：只獲取更新時間在此之後的警報 | `2025-01-01T00:00:00Z`              |
| `limit`         | number  | 每頁數量（預設 50）                    | `50`                                |
| `offset`        | number  | 偏移量（預設 0）                       | `0`                                 |
| `orderBy`       | string  | 排序欄位                               | `created_at`, `severity`, `status`  |
| `order`         | string  | 排序方向                               | `asc`, `desc`                       |

**回應範例**：

```json
{
  "alerts": [
    {
      "id": 1,
      "source": "device",
      "source_id": 5,
      "device_id": 5,
      "alert_type": "offline",
      "severity": "warning",
      "message": "設備 5 連續 5 次無法連接，請檢查狀態",
      "status": "active",
      "resolved": false,
      "ignored": false,
      "resolved_at": null,
      "resolved_by": null,
      "ignored_at": null,
      "ignored_by": null,
      "created_at": "2025-01-15T10:30:00Z",
      "updated_at": "2025-01-15T10:35:00Z",
      "device_name": "感測器 A",
      "device_type_name": "環境感測器",
      "device_type_code": "sensor"
    }
  ],
  "total": 10,
  "limit": 50,
  "offset": 0
}
```

### 2. 取得未解決警報數量

**GET** `/api/alerts/unresolved/count`

**查詢參數**：與取得警報列表相同（`limit`, `offset`, `orderBy`, `order` 除外）

**回應範例**：

```json
{
  "count": 5
}
```

### 3. 取得單一警報

**GET** `/api/alerts/:id`

**回應範例**：

```json
{
  "alert": {
    "id": 1,
    "source": "device",
    "source_id": 5,
    "alert_type": "offline",
    "severity": "warning",
    "message": "設備 5 連續 5 次無法連接，請檢查狀態",
    "status": "active",
    "resolved_by_username": null,
    "ignored_by_username": null,
    "created_at": "2025-01-15T10:30:00Z",
    "updated_at": "2025-01-15T10:35:00Z"
  }
}
```

### 4. 取得警報歷史記錄

**GET** `/api/alerts/:id/history`

**回應範例**：

```json
{
  "history": [
    {
      "id": 1,
      "alert_id": 1,
      "old_status": "active",
      "new_status": "resolved",
      "changed_by": 2,
      "changed_by_username": "admin",
      "changed_at": "2025-01-15T11:00:00Z",
      "reason": "已修復設備連線問題"
    }
  ]
}
```

### 5. 標記警報為未解決

**PUT** `/api/alerts/:id/unresolve`

**需要認證**：是（僅限管理員）

**路徑參數**：

- `id`：警報 ID

**功能說明**：

- **用途**：將已解決或已忽視的警報重新激活為活動狀態
- **適用場景**：
  - 系統誤判問題已解決，需要重新追蹤
  - 問題復發，需要重新監控
  - 需要重新審查已解決的警報
- **效果**：
  - 警報狀態從 `resolved` 或 `ignored` 變回 `active`
  - 清除解決/忽視相關資訊（`resolved_at`、`resolved_by`、`ignored_at`、`ignored_by`）
  - 警報重新顯示在活動警報列表中
  - 觸發 WebSocket 通知
- **權限**：僅限管理員（高級操作，用於處理系統誤判或特殊情況）

**回應範例**：

```json
{
  "alert": {
    "id": 1,
    "status": "active",
    "resolved_at": null,
    "resolved_by": null,
    ...
  }
}
```

### 6. 忽視警報

**POST** `/api/alerts/:deviceId/:alertType/ignore?source=device`

**需要認證**：是（僅限管理員）

**路徑參數**：

- `deviceId`：來源 ID
- `alertType`：警報類型

**查詢參數**：

- `source`：系統來源（可選，預設 `device`）

**回應範例**：

```json
{
  "success": true,
  "message": "已忽視 1 個警示",
  "count": 1
}
```

### 7. 取消忽視警報

**POST** `/api/alerts/:deviceId/:alertType/unignore?source=device`

**需要認證**：是（僅限管理員）

**路徑參數**：

- `deviceId`：來源 ID
- `alertType`：警報類型

**查詢參數**：

- `source`：系統來源（可選，預設 `device`）

**回應範例**：

```json
{
  "success": true,
  "message": "已取消忽視 1 個警示",
  "count": 1
}
```

---

## WebSocket 事件

### 連接方式

使用 Socket.IO 連接到 WebSocket 服務：

```javascript
import io from "socket.io-client";

const socket = io("http://localhost:3001", {
  transports: ["websocket"],
});
```

### 事件類型

#### 1. `alert:new` - 新警報創建

**事件數據**：

```json
{
  "id": 1,
  "source": "device",
  "source_id": 5,
  "alert_type": "offline",
  "severity": "warning",
  "message": "設備 5 連續 5 次無法連接，請檢查狀態",
  "status": "active",
  "created_at": "2025-01-15T10:30:00Z",
  ...
}
```

**監聽範例**：

```javascript
socket.on("alert:new", (alert) => {
  console.log("新警報:", alert);
  // 更新 UI
});
```

#### 2. `alert:updated` - 警報更新

**事件數據**：

```json
{
  "alert": {
    "id": 1,
    "status": "resolved",
    ...
  },
  "oldStatus": "active",
  "newStatus": "resolved",
  "timestamp": "2025-01-15T11:00:00Z"
}
```

**監聽範例**：

```javascript
socket.on("alert:updated", ({ alert, oldStatus, newStatus }) => {
  console.log(`警報 ${alert.id} 狀態變更: ${oldStatus} -> ${newStatus}`);
  // 更新 UI
});
```

#### 3. `alert:count` - 未解決警報數量變化

**事件數據**：

```json
{
  "count": 5,
  "timestamp": "2025-01-15T11:00:00Z"
}
```

**監聽範例**：

```javascript
socket.on("alert:count", ({ count }) => {
  console.log("未解決警報數量:", count);
  // 更新 UI 中的警報數量徽章
});
```

---

## 數據結構

### 警報對象（Alert）

```typescript
interface Alert {
  id: number;
  source: "device" | "environment" | "lighting" | "hvac" | "fire" | "security";
  source_id: number;
  device_id?: number; // 向後兼容，僅當 source === 'device' 時存在
  alert_type: "offline" | "error" | "threshold";
  severity: "warning" | "error" | "critical";
  message: string;
  status: "active" | "resolved" | "ignored";
  resolved: boolean; // 向後兼容
  ignored: boolean; // 向後兼容
  resolved_at: string | null; // ISO 8601
  resolved_by: number | null;
  resolved_by_username: string | null;
  ignored_at: string | null; // ISO 8601
  ignored_by: number | null;
  ignored_by_username: string | null;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  // 設備相關欄位（僅當 source === 'device' 時存在）
  device_name?: string;
  device_type_name?: string;
  device_type_code?: string;
  // 統計欄位（僅在列表查詢時存在）
  alert_count?: number;
}
```

### 警報歷史記錄（Alert History）

```typescript
interface AlertHistory {
  id: number;
  alert_id: number;
  old_status: "active" | "resolved" | "ignored" | null;
  new_status: "active" | "resolved" | "ignored";
  changed_by: number | null;
  changed_by_username: string | null;
  changed_at: string; // ISO 8601
  reason: string | null;
}
```

---

## 使用範例

### 1. 取得活動中的警報列表

```javascript
const response = await fetch("/api/alerts?status=active&limit=20");
const data = await response.json();

console.log(`共有 ${data.total} 個活動中的警報`);
data.alerts.forEach((alert) => {
  console.log(`${alert.severity}: ${alert.message}`);
});
```

### 2. 使用增量查詢優化輪詢

```javascript
let lastUpdateTime = null;

async function pollAlerts() {
  const url = lastUpdateTime
    ? `/api/alerts?updated_after=${lastUpdateTime}`
    : "/api/alerts?status=active";

  const response = await fetch(url);
  const data = await response.json();

  // 更新 UI
  updateAlertList(data.alerts);

  // 記錄最後更新時間
  if (data.alerts.length > 0) {
    lastUpdateTime = data.alerts[0].updated_at;
  }

  // 每 30 秒輪詢一次
  setTimeout(pollAlerts, 30000);
}

pollAlerts();
```

### 3. 監聽 WebSocket 事件

```javascript
import io from "socket.io-client";

const socket = io("http://localhost:3001");

// 監聽新警報
socket.on("alert:new", (alert) => {
  // 顯示通知
  showNotification(alert);

  // 更新警報列表
  addAlertToList(alert);

  // 更新未解決警報數量
  incrementUnresolvedCount();
});

// 監聽警報更新
socket.on("alert:updated", ({ alert, oldStatus, newStatus }) => {
  // 更新警報列表中的項目
  updateAlertInList(alert);

  // 如果從 active 變為 resolved，減少未解決數量
  if (oldStatus === "active" && newStatus === "resolved") {
    decrementUnresolvedCount();
  }
});

// 監聽警報數量變化
socket.on("alert:count", ({ count }) => {
  updateBadgeCount(count);
});
```

### 4. 忽視警報

```javascript
async function ignoreAlert(deviceId, alertType, source = "device") {
  const response = await fetch(
    `/api/alerts/${deviceId}/${alertType}/ignore?source=${source}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  const data = await response.json();
  console.log(data.message); // "已忽視 1 個警示"
}
```

### 5. 篩選特定系統的警報

```javascript
// 取得環境系統的閾值警報
const response = await fetch(
  "/api/alerts?source=environment&alert_type=threshold&status=active"
);
const data = await response.json();
```

### 6. 取得警報歷史記錄

```javascript
async function getAlertHistory(alertId) {
  const response = await fetch(`/api/alerts/${alertId}/history`);
  const data = await response.json();

  data.history.forEach((history) => {
    console.log(
      `${history.changed_by_username} 將警報從 ${history.old_status} 變更為 ${history.new_status}`
    );
  });
}
```

---

## 監控系統

### 概述

警報系統由後台監控服務自動驅動，定期檢查設備狀態和環境數據，自動創建和解決警報。

### 監控架構

#### 1. 背景監控服務（backgroundMonitor.js）

- **功能**：統一管理所有系統的監控任務
- **監控間隔**：每 15 秒執行一次
- **執行方式**：並行執行所有監控任務，提高效率
- **錯誤處理**：連續錯誤超過 5 次時記錄警告

#### 2. 環境系統監控（environmentMonitor.js）

- **監控內容**：
  - 設備連接狀態（Modbus 通訊）
  - 環境參數閾值（CO2、溫度、濕度、PM2.5、PM10、噪音）
- **警報類型**：
  - `offline`：設備連接失敗（連續 5 次錯誤）
  - `threshold`：環境參數超過閾值
- **自動解決**：
  - 設備恢復連接時自動解決 `offline` 警報
  - 環境參數恢復正常時自動解決 `threshold` 警報

#### 3. 照明系統監控（lightingMonitor.js）

- **監控內容**：照明區域設備連接狀態（Modbus 通訊）
- **警報類型**：
  - `offline`：設備連接失敗（連續 5 次錯誤）
- **自動解決**：設備恢復連接時自動解決 `offline` 警報

#### 4. 設備系統監控

- **監控內容**：設備連接狀態（通過環境/照明系統監控間接觸發）
- **警報類型**：
  - `offline`：設備連接失敗（連續 5 次錯誤）
- **自動解決**：設備恢復連接時自動解決 `offline` 警報

### 監控流程

```
背景監控服務 (每 15 秒)
  ├─ 環境系統監控
  │   ├─ 檢查設備連接 → 記錄錯誤/清除錯誤
  │   └─ 檢查環境閾值 → 創建/解決閾值警報
  ├─ 照明系統監控
  │   └─ 檢查設備連接 → 記錄錯誤/清除錯誤
  └─ WebSocket 批次推送設備狀態更新
```

### 環境閾值監控流程

**監控週期**：每 15 秒執行一次

**流程概要**：

1. 檢查設備連接狀態 → 記錄錯誤/清除錯誤
2. 讀取最新感測器讀數
3. 查詢啟用的閾值規則 → 按參數分組
4. 評估每個參數：
   - **超過閾值**：創建/更新警報（僅在 severity 需要升級時更新）
   - **未超過閾值**：檢查並解決對應的 active 警報
5. 推送 WebSocket 事件（新警報或狀態變更）

**優化**：一次性查詢所有 active 警報和規則，避免重複查詢

#### 已實施的優化

1. **✅ 優化警報更新邏輯**（已解決）：

   - 在 `alertService.createAlert` 中先查詢現有警報的 severity
   - 只在 severity 需要升級時才更新資料庫和推送 WebSocket 事件
   - 避免不必要的 `updated_at` 更新和 WebSocket 推送
   - 減少資料庫負擔和網路開銷

2. **✅ 改進警報匹配邏輯**（已解決）：

   - 使用 `findAlertByParameter` 輔助函數統一處理警報匹配
   - 改進匹配算法，先查詢所有 active 警報，然後通過參數名稱匹配
   - 確保 PM2.5 等警報能被正確識別和解決
   - 移除了不再使用的 `resolveThresholdAlert` 函數

3. **✅ 添加調試日誌**（已解決）：

   - 記錄感測器數值、閾值檢查結果、警報創建/更新/解決的操作
   - 使用結構化日誌格式，便於追蹤和診斷問題
   - 記錄無法匹配的警報，便於排查問題

### 錯誤追蹤機制

- **錯誤計數**：系統記錄每個來源的連續錯誤次數
- **閾值觸發**：達到規則定義的錯誤次數（預設 5 次）時創建警報
- **自動清除**：設備恢復正常時自動清除錯誤計數並解決警報

### WebSocket 推送

監控服務在以下情況會推送 WebSocket 事件：

- **設備狀態變化**：`device:status` 事件（批次推送，減少網路開銷）
- **新警報創建**：`alert:new` 事件
- **警報更新**：`alert:updated` 事件（包括狀態變更和嚴重程度升級）
- **警報數量變化**：`alert:count` 事件

### 前端警報監聽

前端使用 `useAlertMonitor` composable 監聽警報：

1. **WebSocket 模式**（優先）：

   - 建立 WebSocket 連接
   - 監聽 `alert:new`、`alert:updated`、`alert:count` 事件
   - 即時顯示通知和更新警報列表

2. **輪詢模式**（WebSocket 斷線時）：

   - 每 30 秒查詢一次
   - 使用增量查詢（`updated_after` 參數）優化效率
   - 只獲取更新時間在最後檢查時間之後的警報

3. **警報通知顯示**：
   - `warning` 級別：警告樣式，持續 5 秒或持久顯示
   - `critical` 級別：錯誤樣式，持續 10 秒或持久顯示
   - 警報解決時自動移除通知

## 注意事項

### 1. 警報自動創建與解決

- **自動創建**：所有警報由系統監控任務自動產生（設備離線、閾值超標、系統錯誤）
- **自動解決**：系統在檢測到問題恢復時自動解決警報
  - 閾值警報：數值恢復正常時自動解決
  - 設備離線警報：設備重新上線時自動解決
  - 錯誤警報：錯誤不再發生時自動解決
- **規則配置**：管理員通過資料庫配置 `alert_rules` 規則來控制警報的產生條件和嚴重程度
- **監控間隔**：每 15 秒執行一次監控任務，確保即時性
- **性能優化**：
  - ✅ 只在 severity 需要升級時才更新警報，避免不必要的資料庫更新
  - ✅ 一次性查詢所有 active 警報和規則，減少資料庫查詢次數
  - ✅ 使用 `findAlertByParameter` 統一處理警報匹配，提高準確性
  - ✅ 添加詳細調試日誌，便於追蹤和診斷問題

### 2. 向後兼容性

- `device_id` 參數仍然支援，但建議使用 `source` 和 `source_id`
- `resolved` 和 `ignored` 布爾值欄位仍然存在，但建議使用 `status` 欄位

### 3. 增量查詢與 WebSocket

- 使用 `updated_after` 參數可以大幅減少不必要的數據傳輸，特別適合輪詢場景
- 建議在應用啟動時建立 WebSocket 連接，處理連接斷開和重連邏輯
- 使用 `transports: ['websocket']` 確保使用 WebSocket 協議

### 4. 警報自動清理

- 超過 30 天的已解決警報會自動備份並從資料庫刪除
- 前端應限制查詢最多 30 天內的警報

---

## 常見問題

### Q: 為什麼同一個設備會有多個相同類型的警報？

A: 系統會自動合併相同來源和類型的 active 警報。如果看到多個，可能是：

- 警報處於不同的狀態（active、resolved、ignored）
- 警報來自不同的系統來源

### Q: 如何判斷警報是否應該顯示？

A: 只顯示 `status === 'active'` 的警報。已解決和已忽視的警報不應在主要警報列表中顯示。

### Q: 警報如何被解決？

A: 所有警報都由系統自動解決。系統在檢測到問題恢復時自動將警報標記為已解決：

- **閾值警報**：數值恢復正常時自動解決
- **設備離線警報**：設備重新上線時自動解決
- **錯誤警報**：錯誤不再發生時自動解決

### Q: 「標記為未解決」的作用是什麼？

A: 將已解決或已忽視的警報重新激活為活動狀態，用於處理系統誤判或問題復發。僅限管理員執行。

### Q: 警報的嚴重程度會自動變化嗎？

A: 是的。當創建新警報時，如果已存在相同來源和類型的 active 警報，系統會自動升級嚴重程度（只升級不降級）。

### Q: 如何配置警報規則？

A: 管理員通過資料庫直接配置 `alert_rules` 表。詳細規則定義請參考 [警報規則規劃文檔](./ALERT_RULES_PLANNING.md)。

---

## 用戶權限與操作限制

### 用戶角色

系統支援三種用戶角色：

| 角色       | 說明   | 權限等級                   |
| ---------- | ------ | -------------------------- |
| `admin`    | 管理員 | 最高權限，可執行所有操作   |
| `operator` | 操作員 | 中等權限，可執行大部分操作 |
| `viewer`   | 查看者 | 最低權限，主要用於查看     |

### 警報系統操作權限

#### 1. 查詢操作（公開，無需認證）

以下操作**不需要認證**，任何人都可以訪問：

- ✅ 取得警報列表（`GET /api/alerts`）
- ✅ 取得未解決警報數量（`GET /api/alerts/unresolved/count`）
- ✅ 取得單一警報（`GET /api/alerts/:id`）
- ✅ 取得警報歷史記錄（`GET /api/alerts/:id/history`）

#### 2. ~~需要認證的操作~~（已移除）

**說明**：警報由系統自動創建和解決，用戶無法手動操作。所有解決都是系統驗證後的結果。

#### 3. 需要管理員權限的操作

以下操作**僅限管理員**（`role === 'admin'`）：

- 🔒 忽視警報（`POST /api/alerts/:deviceId/:alertType/ignore`）
- 🔒 取消忽視警報（`POST /api/alerts/:deviceId/:alertType/unignore`）
- 🔒 標記警報為未解決（`PUT /api/alerts/:id/unresolve`）

**說明**：

- 忽視警報是管理員專屬操作，用於永久隱藏不需要處理的警報
- 只有管理員可以將已解決的警報重新激活

### 權限檢查

- **認證**：JWT Token（`Authorization: Bearer <token>`），失敗：`401 Unauthorized`
- **角色**：管理員操作需要 `role === 'admin'`，失敗：`403 Forbidden`

**其他系統權限**：

- **設備/環境/照明系統**：查詢公開，管理操作需要管理員
- **用戶管理**：註冊/登入公開，其他操作需要認證或管理員

### 權限限制總結表

| 操作                   | 公開 | 已認證 | 操作員 | 管理員 |
| ---------------------- | ---- | ------ | ------ | ------ |
| 查看警報列表           | ✅   | ✅     | ✅     | ✅     |
| 查看警報詳情           | ✅   | ✅     | ✅     | ✅     |
| 查看警報歷史           | ✅   | ✅     | ✅     | ✅     |
| ~~創建警報~~           | ❌   | ❌     | ❌     | ❌     |
| ~~解決警報~~（自動）   | ❌   | ❌     | ❌     | ❌     |
| 忽視警報               | ❌   | ❌     | ❌     | ✅     |
| 取消忽視               | ❌   | ❌     | ❌     | ✅     |
| 未解決警報             | ❌   | ❌     | ❌     | ✅     |
| 配置警報規則（資料庫） | ❌   | ❌     | ❌     | ✅     |
| 管理設備               | ❌   | ❌     | ❌     | ✅     |
| 管理用戶               | ❌   | ❌     | ❌     | ✅     |

**注意**：警報由系統自動創建和解決，用戶無法手動操作。管理員可以通過資料庫配置 `alert_rules` 規則來控制警報的產生。

### 其他注意事項

- **公開端點**：建議前端檢查用戶認證狀態以提供更好的用戶體驗
- **操作記錄**：認證操作記錄操作者資訊用於審計，自動解決的警報不記錄操作者

---

**文檔結束**
