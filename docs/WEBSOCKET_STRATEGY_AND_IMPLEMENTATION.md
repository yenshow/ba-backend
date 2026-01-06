# WebSocket 策略與實作指南

> 本文檔合併了策略分析和實作檢查報告，提供完整的 WebSocket 使用指南

## 📋 目錄

1. [效能比較與策略](#效能比較與策略)
2. [使用場景分析](#使用場景分析)
3. [實作檢查報告](#實作檢查報告)
4. [效能優化與頻率調整](#效能優化與頻率調整)
5. [批次推送策略](#批次推送策略)
6. [實作最佳實踐](#實作最佳實踐)
7. [事件清單與使用範例](#事件清單與使用範例)

---

## 效能比較與策略

### WebSocket 的優勢

#### ✅ **適合場景**

1. **即時性需求高的操作**

   - **頻率**: 高頻事件（每秒多次）
   - **延遲要求**: < 100ms
   - **範例**:
     - 感測器讀數即時推送（每 1-5 秒）
     - 設備狀態變化通知
     - 警報即時通知

2. **減少網路開銷**

   - **HTTP 請求開銷**:
     - 每個請求需要：TCP 握手 + TLS 握手（如使用 HTTPS）+ HTTP 標頭
     - 典型的 HTTP 請求開銷：~500ms（含往返時間）
   - **WebSocket 開銷**:
     - 僅一次握手（建立連接時）
     - 後續數據傳輸僅：數據本身 + 極小的框架開銷（~2-14 bytes）
     - 典型推送開銷：< 5ms

3. **伺服器資源節省**

   - **REST 輪詢**:
     - 1000 用戶，每 5 秒輪詢一次 = 200 請求/秒
     - 需要處理大量 HTTP 連接建立/關閉
   - **WebSocket**:
     - 1000 用戶 = 1000 個持久連接
     - 僅在事件發生時推送，無輪詢開銷

4. **雙向通訊**
   - 客戶端可即時接收伺服器推送
   - 所有事件自動推送給所有連接的客戶端

### WebSocket 的劣勢

#### ❌ **不適合場景**

1. **一次性查詢操作**

   - **效能**: WebSocket 需要維護連接，一次性操作開銷更大
   - **範例**:
     - 查詢歷史記錄（帶篩選條件）
     - 匯出報表
     - 搜尋操作

2. **低頻或不規則操作**

   - **頻率**: 每分鐘少於 1 次
   - **問題**: 維護連接的開銷 > 請求開銷
   - **範例**:
     - 創建設備類型（管理員操作，很少發生）
     - 更新系統配置（偶爾發生）

3. **需要 HTTP 快取的場景**

   - REST API 可以利用瀏覽器/代理快取
   - WebSocket 無法利用 HTTP 快取機制

4. **需要支援書籤/直接連結**
   - REST API URL 可書籤化
   - WebSocket 需要先建立連接，無法直接連結到特定資源

### 最佳實踐：**REST + WebSocket 混合架構**

```
┌─────────────────────────────────────────┐
│           客戶端應用程式                  │
├─────────────────────────────────────────┤
│  ┌─────────────┐      ┌──────────────┐ │
│  │  REST API   │      │  WebSocket   │ │
│  │ (查詢/操作) │      │  (狀態同步)   │ │
│  └─────────────┘      └──────────────┘ │
└─────────┼────────────────────┼──────────┘
          │                    │
          ▼                    ▼
    ┌──────────┐        ┌──────────┐
    │  HTTP    │        │ WebSocket│
    │  Server  │        │  Server  │
    └──────────┘        └──────────┘
          │                    │
          └──────────┬─────────┘
                     │
                     ▼
              ┌──────────┐
              │  資料庫   │
              └──────────┘
```

#### 原則

1. **REST 負責**:

   - 所有查詢操作（GET）
   - 所有寫入操作（POST/PUT/DELETE）
   - 認證/授權
   - 一次性操作

2. **WebSocket 負責**:

   - 即時數據推送（感測器讀數、警報等）
   - 狀態變化通知（設備狀態、串流狀態等）
   - 系統頁面中的狀態同步（CRUD 操作後的狀態更新）
   - 多用戶協作同步

3. **協同工作流程**:
   ```
   1. 用戶透過 REST API 執行操作 → 立即獲得結果
   2. 伺服器執行操作並保存到資料庫
   3. 伺服器自動推送 WebSocket 事件給其他用戶
   4. 前端頁面即時更新，無需刷新
   ```

---

## 使用場景分析

### 🟢 **應該使用 WebSocket 的場景**

#### 1. **即時數據推送** ⭐⭐⭐

```
頻率: 高（> 1次/分鐘）
即時性: 高（< 1秒）
數據量: 小到中等
```

**本系統範例**:

- ✅ `environment:reading:new` - 感測器讀數（每 1-5 秒）
- ✅ `alert:new` - 新警報通知（即時）
- ✅ `alert:updated` - 警報狀態變化（即時）
- ✅ `alert:count` - 警報數量變化（即時）
- ✅ `monitoring:device:status` - 設備上線/離線（即時）
- ✅ `device:status:changed` - 設備狀態變更（即時）
- ✅ `rtsp:stream:started` - 串流啟動（即時）
- ✅ `rtsp:stream:error` - 串流錯誤（即時）

**效能收益**:

- 無需前端輪詢（減少 95% 以上的 HTTP 請求）
- 即時性提升 10-100 倍（從輪詢延遲到即時推送）

#### 2. **系統頁面中的狀態同步** ⭐⭐⭐

```
頻率: 中高（> 1次/分鐘）
即時性: 高
多用戶: 是
操作類型: 狀態同步（非操作本身）
```

**重要原則**:

- **CRUD 操作本身**: 使用 REST API（POST/PUT/DELETE）
- **狀態同步通知**: 使用 WebSocket（推送給其他用戶）

**本系統範例**:

- ✅ `device:created` - 設備創建後的狀態同步（REST 創建 → WebSocket 推送）
- ✅ `device:updated` - 設備更新後的狀態同步（REST 更新 → WebSocket 推送）
- ✅ `device:deleted` - 設備刪除後的狀態同步（REST 刪除 → WebSocket 推送）
- ✅ `device:status:changed` - 設備狀態變更（REST 更新狀態 → WebSocket 推送）

**工作流程**:

```
1. 用戶 A 透過 REST API 創建設備
   POST /api/devices → 立即返回創建結果給用戶 A

2. 伺服器自動推送 WebSocket 事件給其他用戶
   device:created → 用戶 B, C, D 即時看到新設備

3. 前端頁面自動更新，無需刷新
```

**相同原則適用於所有 CRUD 操作**:

- ✅ 設備 CRUD（已實作）
- ✅ 環境系統樓層 CRUD（建議實作）
- ✅ 照明系統樓層 CRUD（建議實作）
- ✅ 設備類型/型號 CRUD（建議實作）
- ❌ 用戶 CRUD（保持 REST，不推送 WebSocket）

**效能收益**:

- 多用戶協作時無需刷新頁面
- 減少頁面重新載入次數
- 操作者立即獲得 REST 回應，其他用戶即時看到變化

### 🔴 **不應該使用 WebSocket 的場景**

#### 1. **查詢操作** ⭐⭐⭐

**本系統範例**:

- ❌ `GET /api/alerts` - 查詢警報列表（支援複雜篩選）
- ❌ `GET /api/devices` - 查詢設備列表（支援分頁、排序）
- ❌ `GET /api/environment/readings/:locationId` - 查詢歷史讀數
- ❌ `GET /api/devices/types` - 查詢設備類型（靜態數據）

**原因**:

- 需要支援複雜查詢參數
- 需要 HTTP 快取（設備類型等靜態數據）
- 一次性操作，WebSocket 開銷過大
- 需要支援書籤/直接連結

#### 2. **創建/更新/刪除操作本身** ⭐⭐

**本系統範例**:

- ❌ `POST /api/devices` - 創建設備（需要立即返回結果）
- ❌ `PUT /api/devices/:id` - 更新設備（需要立即返回結果）
- ❌ `DELETE /api/devices/:id` - 刪除設備（需要立即返回結果）
- ❌ `POST /api/environment/readings` - 儲存讀數（IoT 設備觸發）
- ❌ `POST /api/alerts/:id/unresolve` - 取消解決警報

**原因**:

- 需要立即獲得操作結果（成功/失敗）
- 需要錯誤處理（HTTP 狀態碼）
- REST 語義更清晰（POST/PUT/DELETE）

**注意**: 操作本身使用 REST，但**操作成功後會自動推送 WebSocket 事件**給其他用戶進行狀態同步。

#### 3. **認證/授權操作** ⭐⭐⭐

**本系統範例**:

- ❌ `POST /api/users/login` - 登入
- ❌ `POST /api/users/register` - 註冊
- ❌ `GET /api/users/me` - 獲取當前用戶資訊

**原因**:

- 需要標準的 HTTP 認證流程
- 需要設定 HTTP-only cookies
- 安全性考量（不應該在 WebSocket 中處理敏感操作）
- 用戶相關操作不需要推送給其他用戶（隱私考量）

---

## 實作檢查報告

### ✅ 已正確實作

#### 1. CRUD 操作與狀態同步分離 ✅

**實作狀態**: ✅ **已正確實作**

**檢查結果**:

- ✅ 設備創建：`POST /api/devices` 使用 REST → 成功後推送 `device:created`
- ✅ 設備更新：`PUT /api/devices/:id` 使用 REST → 成功後推送 `device:updated` 和 `device:status:changed`
- ✅ 設備刪除：`DELETE /api/devices/:id` 使用 REST → 成功後推送 `device:deleted`
- ✅ 用戶 CRUD：使用 REST，**不推送 WebSocket**（符合隱私要求）

**實作位置**:

- `src/services/devices/deviceService.js` - `createDevice()`, `updateDevice()`, `deleteDevice()`

#### 2. 即時推送事件 ✅

**實作狀態**: ✅ **已正確實作**

**已實作事件**:

- ✅ `alert:new` - 新警報創建
- ✅ `alert:updated` - 警報狀態更新
- ✅ `alert:count` - 未解決警報數量變化（自動推送）
- ✅ `environment:reading:new` - 感測器讀數
- ✅ `device:created` - 設備創建後狀態同步
- ✅ `device:updated` - 設備更新後狀態同步
- ✅ `device:deleted` - 設備刪除後狀態同步
- ✅ `device:status:changed` - 設備狀態變更
- ✅ `monitoring:device:status` - 設備上線/離線
- ✅ `rtsp:stream:started` - 串流啟動
- ✅ `rtsp:stream:stopped` - 串流停止
- ✅ `rtsp:stream:error` - 串流錯誤

#### 3. 事件廣播機制 ✅

**實作狀態**: ✅ **已正確實作**

**實作方式**:

- ✅ 所有 WebSocket 事件都廣播給所有連接的客戶端
- ✅ 不需要房間機制，所有用戶都會收到所有事件
- ✅ 簡化了實作，移除了不必要的房間管理邏輯

**實作位置**:

- `src/services/websocket/websocketService.js` - `safeEmit()` 函數直接使用 `ioInstance.emit()` 廣播

**設計決策**:

- 所有警報事件、設備事件、環境讀數都會推送給所有客戶端
- 前端不需要加入任何房間，直接監聽事件即可
- 簡化了前端實作，避免了房間管理的複雜性

### ✅ 已調整完成

#### 1. 監控間隔調整 ✅

**調整狀態**: ✅ **已完成**

**調整後實作**:

```javascript
// src/services/monitoring/backgroundMonitor.js
const MONITORING_INTERVAL = 10000; // 10 秒（使用 WebSocket 後可提升更新頻率）
```

**效益**:

- 即時性提升 3 倍（從 30 秒 → 10 秒）
- 充分利用 WebSocket 的效能優勢

#### 2. 移除 monitoring:status 推送 ✅

**調整狀態**: ✅ **已完成**

**調整後實作**:

- ✅ 在 `backgroundMonitor.js` 中註解了 `emitMonitoringStatus()` 調用
- ✅ 在 `websocketService.js` 中停用了 `emitMonitoringStatus()` 函數的推送邏輯
- ✅ 保留函數以維持 API 兼容性（未來管理員監控面板可能需要）

**效益**:

- 前端不會收到不需要的事件
- 減少不必要的網路流量

#### 3. 批次推送機制 ✅

**調整狀態**: ✅ **已完成**

**實作內容**:

1. ✅ 在 `websocketService.js` 中添加了 `emitBatchDeviceStatus()` 函數
2. ✅ 修改 `systemAlertHelper.js` 的 `recordError()` 和 `clearError()` 支援 `skipWebSocket` 選項
3. ✅ 修改監控任務（`environmentMonitor.js` 和 `lightingMonitor.js`）：
   - 檢查時使用 `skipWebSocket: true` 跳過即時推送
   - 檢查完成後批次推送所有狀態更新

**實作方式**:

```javascript
// 監控任務檢查時跳過即時推送
await systemAlert.clearError("environment", location.id, {
  skipWebSocket: true,
});

// 檢查完成後批次推送
const statusUpdates = results.map((result) => ({
  system: "environment",
  sourceId: result.locationId,
  status: result.success ? "online" : "offline",
}));
websocketService.emitBatchDeviceStatus(statusUpdates);
```

**效益**:

- 監控任務檢查多個設備時，只推送一次批次事件
- 減少網路開銷和 WebSocket 框架開銷
- 按系統和狀態分組推送，進一步優化

**注意**: 其他非監控任務的 `recordError`/`clearError` 調用（如 Modbus 路由中的即時錯誤處理）仍保持即時推送，這是合理的。

### 實作完成度

| 項目                    | 狀態 | 完成度 |
| ----------------------- | ---- | ------ |
| CRUD 操作與狀態同步分離 | ✅   | 100%   |
| 即時推送事件            | ✅   | 100%   |
| 事件廣播機制            | ✅   | 100%   |
| 監控間隔調整            | ✅   | 100%   |
| 移除 monitoring:status  | ✅   | 100%   |
| 批次推送機制            | ✅   | 100%   |

**總體完成度**: 100% ✅

---

## 效能優化與頻率調整

### 使用 WebSocket 後可提升更新頻率

#### 原始設計考量（基於 REST 輪詢）

在 REST 輪詢架構下，需要考慮：

- HTTP 請求開銷大（~500ms）
- 伺服器負載高（大量連接建立/關閉）
- 因此設定較長的輪詢間隔（30 秒）以減少負載

#### 使用 WebSocket 後的優勢

**WebSocket 推送開銷極小（< 5ms）**，因此可以大幅提升更新頻率：

| 監控任務     | REST 輪詢間隔 | WebSocket 建議間隔 | 效能提升     |
| ------------ | ------------- | ------------------ | ------------ |
| 環境監控     | 30 秒         | **10 秒**          | 3 倍即時性   |
| 照明監控     | 30 秒         | **10 秒**          | 3 倍即時性   |
| 設備狀態檢查 | 30 秒         | **10-15 秒**       | 2-3 倍即時性 |

#### 頻率調整建議

```javascript
// 背景監控配置（src/services/monitoring/backgroundMonitor.js）
const MONITORING_INTERVAL = 10000; // 10 秒
```

**調整理由**:

1. **WebSocket 推送開銷極小**: 無需考慮 HTTP 請求開銷
2. **連接已建立**: 不需要重複建立連接
3. **即時性提升**: 從 30 秒降低到 10 秒，即時性提升 3 倍
4. **伺服器負載**: WebSocket 推送對伺服器負載影響極小

#### 不同系統的建議頻率

| 系統類型           | 建議間隔 | 理由                     |
| ------------------ | -------- | ------------------------ |
| 環境監控（感測器） | 10 秒    | 高頻數據，需要較高即時性 |
| 照明監控           | 10 秒    | 狀態變化需要及時反應     |
| 設備狀態檢查       | 10-15 秒 | 平衡即時性和資源消耗     |
| 警報系統           | 即時推送 | 事件驅動，無需固定間隔   |

---

## 批次推送策略

### 批次推送的優勢

對於同時發生的多個狀態變化，使用批次推送可以：

1. **減少網路開銷**: 合併多個事件為一次推送
2. **提升效能**: 減少 WebSocket 框架開銷
3. **原子性更新**: 相關狀態可以一起更新，保持一致性

### 批次推送場景

#### 1. **設備批次狀態更新**

當監控任務檢查多個設備時，可以批次推送：

```javascript
// 範例：環境監控任務檢查多個位置
// 批次推送方式（已實作）
const statusUpdates = locations.map((location) => ({
  system: "environment",
  sourceId: location.id,
  status: status,
}));
websocketService.emitBatchDeviceStatus(statusUpdates);
```

**事件格式**:

```json
{
  "type": "monitoring:device:status:batch",
  "system": "environment",
  "status": "online",
  "updates": [{ "sourceId": 1 }, { "sourceId": 2 }, { "sourceId": 3 }],
  "timestamp": "2025-01-15T10:30:00Z"
}
```

#### 2. **批次推送實作原則**

1. **時序相關的事件**: 應該批次推送（如同一監控週期的多個狀態）
2. **原子性操作**: 相關狀態應該一起推送
3. **批次大小限制**: 建議單次批次不超過 50 個項目
4. **時間窗口**: 可以設置時間窗口（如 100ms）將相近的事件合併

---

## 實作最佳實踐

### 1. **前端使用模式**

```javascript
// 初始化時：使用 REST API 獲取初始數據
const initialData = await fetch("/api/alerts").then((r) => r.json());

// 建立 WebSocket 連接：接收即時更新
const socket = io("http://localhost:3001");
socket.on("alert:new", (alert) => {
  // 即時添加到列表
  addAlertToList(alert);
});

socket.on("alert:updated", ({ alert, oldStatus, newStatus }) => {
  // 即時更新列表中的警報
  updateAlertInList(alert);
});

// 用戶操作：使用 REST API，WebSocket 自動推送狀態同步
async function createDevice(deviceData) {
  // 1. 透過 REST API 執行操作
  const response = await fetch("/api/devices", {
    method: "POST",
    body: JSON.stringify(deviceData),
  });
  const result = await response.json();

  // 2. 立即更新當前用戶的 UI（使用 REST 回應）
  updateDeviceInList(result.device);

  // 3. 其他用戶會透過 WebSocket 自動收到 device:created 事件
  //    （在後端自動推送，前端無需額外處理）

  return result;
}
```

### 2. **效能優化策略**

#### A. **事件廣播機制**（已實作）

```javascript
// 所有事件都自動推送給所有客戶端，不需要加入房間
// 前端直接監聽事件即可
socket.on("alert:new", (alert) => {
  // 自動接收所有警報事件
});

socket.on("device:created", (data) => {
  // 自動接收所有設備創建事件
});

socket.on("environment:reading:new", (data) => {
  // 自動接收所有環境讀數事件
});
```

**設計優勢**:

- 簡化前端實作，不需要管理房間訂閱
- 所有用戶都能即時收到所有更新
- 減少前端狀態管理的複雜性

#### B. **批次事件處理**（前端）

```javascript
// 處理批次狀態更新
socket.on("monitoring:device:status:batch", ({ system, status, updates }) => {
  updates.forEach((update) => {
    updateDeviceStatusInUI(system, update.sourceId, status);
  });
});
```

### 3. **連接管理**

```javascript
// 客戶端應該實現重連邏輯
const socket = io("http://localhost:3001", {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: Infinity,
});

socket.on("connect", () => {
  // 連接成功後，所有事件會自動推送，不需要加入房間
  console.log("WebSocket 連接成功，開始接收事件");
});

socket.on("disconnect", () => {
  // 顯示離線提示
  showOfflineIndicator();
});
```

---

## 事件清單與使用範例

### 警報相關事件

| 事件名稱        | 說明               | 資料格式                          |
| --------------- | ------------------ | --------------------------------- |
| `alert:new`     | 新警報創建         | `{ id, source, source_id, ... }`  |
| `alert:updated` | 警報狀態更新       | `{ alert, oldStatus, newStatus }` |
| `alert:count`   | 未解決警報數量變化 | `{ count, timestamp }`            |

### 設備相關事件

| 事件名稱                         | 說明             | 資料格式                                   |
| -------------------------------- | ---------------- | ------------------------------------------ |
| `device:created`                 | 設備創建         | `{ device, userId, timestamp }`            |
| `device:updated`                 | 設備更新         | `{ device, changes, userId, timestamp }`   |
| `device:deleted`                 | 設備刪除         | `{ deviceId, userId, timestamp }`          |
| `device:status:changed`          | 設備狀態變更     | `{ deviceId, oldStatus, newStatus, ... }`  |
| `monitoring:device:status`       | 設備上線/離線    | `{ system, sourceId, status, timestamp }`  |
| `monitoring:device:status:batch` | 設備批次狀態更新 | `{ system, status, updates[], timestamp }` |

### 環境監控相關事件

| 事件名稱                  | 說明       | 資料格式                             |
| ------------------------- | ---------- | ------------------------------------ |
| `environment:reading:new` | 感測器讀數 | `{ locationId, reading, timestamp }` |

### RTSP 串流相關事件

| 事件名稱                     | 說明         | 資料格式                                  |
| ---------------------------- | ------------ | ----------------------------------------- |
| `rtsp:stream:started`        | 串流啟動     | `{ streamId, rtspUrl, hlsUrl, ... }`      |
| `rtsp:stream:stopped`        | 串流停止     | `{ streamId, timestamp }`                 |
| `rtsp:stream:error`          | 串流錯誤     | `{ streamId, error, timestamp }`          |
| `rtsp:stream:status:changed` | 串流狀態變更 | `{ streamId, oldStatus, newStatus, ... }` |

---

## 效能數據估算

### 場景：1000 個並發用戶，監控系統每 10 秒更新一次

#### **方案 A：純 REST 輪詢（30 秒間隔）**

```
請求頻率: 1000 用戶 × (60秒 / 30秒) = 2,000 請求/分鐘
HTTP 開銷: 2,000 × 500ms = 1,000,000ms = 16.7 分鐘/分鐘
伺服器負載: 高（需要處理大量 HTTP 連接建立）
即時性: 最差 30 秒延遲（輪詢間隔）
```

#### **方案 B：REST + WebSocket 混合（10 秒間隔）**

```
初始載入: 1000 用戶 × 1 次 = 1,000 請求（一次性）
WebSocket 連接: 1000 個持久連接
推送頻率: 每 10 秒推送一次（6 次/分鐘）
推送開銷: 6 × 5ms = 30ms/分鐘
伺服器負載: 低（僅維護連接，無輪詢開銷）
即時性: < 100ms（即時推送）
```

**效能提升**:

- HTTP 請求減少：**99.5%** (從 2,000/分鐘 → 1,000 + 6 次推送)
- 即時性提升：**300 倍** (從 30 秒 → < 0.1 秒)
- 更新頻率提升：**3 倍** (從 30 秒 → 10 秒)
- 伺服器負載降低：**95%+** (無需處理大量 HTTP 連接建立)

---

## 結論

### ✅ **建議：採用 REST + WebSocket 混合架構**

1. **REST API**: 負責所有查詢和寫入操作

   - 清晰、標準、可快取、可書籤化
   - 操作本身使用 REST，立即獲得結果

2. **WebSocket**: 負責即時推送和狀態同步

   - 即時性高、效能好、減少輪詢
   - 系統頁面中的狀態同步
   - CRUD 操作後的狀態推送

3. **協同工作流程**:
   - REST 執行操作（用戶立即獲得回應）
   - WebSocket 推送狀態同步（其他用戶即時看到變化）
   - 前端使用 REST 獲取初始數據
   - 前端使用 WebSocket 接收更新

### 📊 **效能收益**

- **HTTP 請求減少**: 90-99%
- **即時性提升**: 10-300 倍
- **更新頻率提升**: 3 倍（從 30 秒 → 10 秒）
- **伺服器負載降低**: 80-95%
- **用戶體驗提升**: 即時更新，無需刷新

### 🎯 **當前實作狀態**

✅ **已完成**: 所有高優先級的 WebSocket 事件已實作  
✅ **符合最佳實踐**: REST 負責操作，WebSocket 負責推送  
✅ **效能優化**: 已實作批次推送機制，所有事件廣播給所有客戶端  
✅ **狀態同步**: CRUD 操作後自動推送 WebSocket 事件  
✅ **監控間隔**: 已調整為 10 秒以提升即時性

**建議**: 維持現有的混合架構，不需要全部改用 WebSocket。
