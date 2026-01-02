# 警報系統 API 文檔（前端開發參考）

**最後更新**：2025-01-XX  
**適用版本**：後端 v1.0+

---

## 📋 目錄

1. [系統概覽](#系統概覽)
2. [API 端點](#api-端點)
3. [WebSocket 事件](#websocket-事件)
4. [數據結構](#數據結構)
5. [使用範例](#使用範例)

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

## 注意事項

### 1. 警報自動創建與解決

- **自動創建**：所有警報由系統監控任務自動產生（設備離線、閾值超標、系統錯誤）
- **自動解決**：系統在檢測到問題恢復時自動解決警報
  - 閾值警報：數值恢復正常時自動解決
  - 設備離線警報：設備重新上線時自動解決
  - 錯誤警報：錯誤不再發生時自動解決
- **規則配置**：管理員通過資料庫配置 `alert_rules` 規則來控制警報的產生條件和嚴重程度

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

A: 管理員通過資料庫直接配置 `alert_rules` 表，包括閾值規則、錯誤次數規則和嚴重程度設定。

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

### 其他系統操作權限

#### 設備管理

| 操作                   | 權限要求 |
| ---------------------- | -------- |
| 查詢設備列表/詳情      | 公開     |
| 創建設備               | 管理員   |
| 更新設備               | 管理員   |
| 刪除設備               | 管理員   |
| 創建/更新/刪除設備類型 | 管理員   |
| 創建/更新/刪除設備型號 | 管理員   |

#### 環境系統

| 操作               | 權限要求         |
| ------------------ | ---------------- |
| 查詢樓層/位置/讀數 | 公開             |
| 創建/更新/刪除樓層 | 需要認證         |
| 儲存感測器讀數     | 公開（系統自動） |

#### 照明系統

| 操作               | 權限要求 |
| ------------------ | -------- |
| 查詢樓層/區域      | 公開     |
| 創建/更新/刪除樓層 | 需要認證 |
| 控制照明設備       | 需要認證 |

#### 用戶管理

| 操作                | 權限要求                                     |
| ------------------- | -------------------------------------------- |
| 註冊/登入           | 公開                                         |
| 取得當前用戶資訊    | 需要認證                                     |
| 更新自己的資訊/密碼 | 需要認證（只能更新自己）                     |
| 取得用戶列表        | 管理員                                       |
| 取得單一用戶        | 管理員                                       |
| 更新其他用戶資訊    | 需要認證（只能更新自己，管理員可更新任何人） |
| 刪除用戶            | 管理員                                       |

### 權限檢查

- **認證檢查**：需要有效的 JWT Token（`Authorization: Bearer <token>`）
  - 失敗回應：`401 Unauthorized`
- **角色檢查**：管理員操作需要 `role === 'admin'`
  - 失敗回應：`403 Forbidden`

### 前端權限控制建議

```javascript
// 權限 Hook 範例
function usePermissions() {
  const { user } = useAuth();
  return {
    canIgnore: user?.role === "admin", // 只有管理員可以忽視
    canUnresolve: user?.role === "admin", // 只有管理員可以重新激活
    canView: true, // 所有人都可以查看
  };
}

// 使用範例
function AlertActions({ alert }) {
  const { canIgnore, canUnresolve } = usePermissions();
  return (
    <div>
      {canIgnore && <Button onClick={() => handleIgnore(alert)}>忽視</Button>}
      {canUnresolve && alert.status === "resolved" && (
        <Button onClick={() => handleUnresolve(alert)}>未解決</Button>
      )}
    </div>
  );
}
```

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

1. **公開端點**：雖然查詢操作是公開的，但建議前端仍然檢查用戶認證狀態，以便提供更好的用戶體驗。

2. **操作記錄**：需要認證的操作會記錄操作者資訊（`ignored_by` 等），用於審計。自動解決的警報不會記錄操作者（`resolved_by = null`）。

---

**文檔結束**
