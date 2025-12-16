# 警報系統文檔

## 概述

本系統提供統一的設備警報管理功能，支援多種警報類型和嚴重程度，適用於所有設備類型。

---

## 警報類型 (Alert Types)

系統定義了以下 4 種警報類型：

| 類型代碼 | 類型名稱 | 說明 | 適用場景 |
|---------|---------|------|---------|
| `offline` | 設備離線 | 設備無法連接或無回應 | 設備離線、連接超時、無法到達 |
| `error` | 通訊錯誤 | 設備通訊過程中發生錯誤 | 通訊協議錯誤、連接被拒絕、資料讀取失敗 |
| `threshold` | 閾值超標 | 感測器數值超過設定的閾值 | CO2 濃度超標、溫度異常、濕度異常等 |
| `maintenance` | 維護提醒 | 設備需要定期維護或檢查 | 定期維護、保養提醒、檢查通知 |

---

## 警報嚴重程度 (Alert Severity)

系統定義了以下 4 個嚴重程度等級：

| 嚴重程度 | 代碼 | 說明 | 使用場景 |
|---------|------|------|---------|
| 資訊 | `info` | 一般資訊提示 | 維護提醒、狀態通知 |
| 警告 | `warning` | 需要關注但不緊急 | 設備離線、閾值接近上限 |
| 錯誤 | `error` | 需要處理的問題 | 通訊錯誤、連接失敗 |
| 嚴重 | `critical` | 需要立即處理 | 長時間離線、嚴重故障 |

---

## 設備類型適配

### 目前支援的設備類型

| 設備類型 | 代碼 | 說明 | 適配的警報類型 |
|---------|------|------|---------------|
| 攝影機 | `camera` | 影像監控、車牌辨識、人流統計 | `offline`, `error`, `maintenance` |
| 感測器 | `sensor` | 感測器設備（Modbus/HTTP/MQTT） | `offline`, `error`, `threshold`, `maintenance` |
| 控制器 | `controller` | Modbus 控制器 | `offline`, `error`, `maintenance` |
| 平板 | `tablet` | 平板電腦設備 | `offline`, `error`, `maintenance` |
| 網路裝置 | `network` | 路由器、交換器、無線基地台 | `offline`, `error`, `maintenance` |

---

## 警報訊息範例

### 感測器設備 (sensor)

#### 1. 離線警報
```javascript
{
  device_id: 1,
  alert_type: "offline",
  severity: "warning",
  message: "感測器設備「展廳感測器」離線，無法讀取資料"
}
```

#### 2. 長時間離線（嚴重）
```javascript
{
  device_id: 1,
  alert_type: "offline",
  severity: "critical",
  message: "感測器設備「展廳感測器」長時間離線，請立即處理"
}
```

#### 3. 通訊錯誤
```javascript
{
  device_id: 1,
  alert_type: "error",
  severity: "error",
  message: "感測器設備「展廳感測器」通訊錯誤，請檢查連接"
}
```

#### 4. 閾值超標
```javascript
{
  device_id: 1,
  alert_type: "threshold",
  severity: "warning",
  message: "感測器設備「展廳感測器」CO2 濃度超過閾值 (800 ppm)"
}
```

#### 5. 維護提醒
```javascript
{
  device_id: 1,
  alert_type: "maintenance",
  severity: "info",
  message: "感測器設備「展廳感測器」需要定期維護檢查"
}
```

### 控制器設備 (controller)

#### 1. 離線警報
```javascript
{
  device_id: 2,
  alert_type: "offline",
  severity: "warning",
  message: "控制器設備「展廳控制器」離線，無法連接"
}
```

#### 2. Modbus 連接錯誤
```javascript
{
  device_id: 2,
  alert_type: "error",
  severity: "error",
  message: "控制器設備「展廳控制器」Modbus 連接超時，請檢查網路連線"
}
```

### 攝影機設備 (camera)

#### 1. 離線警報
```javascript
{
  device_id: 3,
  alert_type: "offline",
  severity: "warning",
  message: "攝影機設備「入口攝影機」離線，無法取得影像串流"
}
```

#### 2. RTSP 連接錯誤
```javascript
{
  device_id: 3,
  alert_type: "error",
  severity: "error",
  message: "攝影機設備「入口攝影機」RTSP 串流連接失敗"
}
```

### 網路裝置 (network)

#### 1. 離線警報
```javascript
{
  device_id: 4,
  alert_type: "offline",
  severity: "warning",
  message: "網路裝置「主路由器」離線，無法 ping 通"
}
```

---

## 設備型號適配

### 目前資料庫中的設備型號

| 型號 ID | 型號名稱 | 設備類型 | 預設端口 | 說明 |
|---------|---------|---------|---------|------|
| 3 | ZC160 | controller | 502 | 展廳測試 DI / DO |

**注意：** 警報系統是基於**設備 (devices)** 而非設備型號 (device_models)。每個設備都可以產生警報，不論其型號為何。

---

## 自動警報觸發機制

### 目前實現的自動警報

#### 1. 感測器離線檢測（前端）

**位置：** `app/pages/index.vue`

**觸發條件：**
- Modbus API 返回 503 Service Unavailable
- 連接超時錯誤

**處理邏輯：**
- 檢測到 503 錯誤時，顯示 Toast 警告
- 使用防抖機制（30 秒間隔）避免重複提示
- **注意：** 目前僅在前端顯示 Toast，尚未自動創建資料庫警報記錄

**未來改進建議：**
- 當檢測到設備離線時，自動調用 `POST /api/alerts` 創建警報記錄
- 當設備恢復連線時，自動標記相關的 `offline` 警報為已解決

### 2. 後端錯誤處理

**位置：** `src/server.js`

**觸發條件：**
- Modbus 連接超時
- Modbus 連接被拒絕
- 無法到達設備
- 連接已斷開

**處理邏輯：**
- 自動返回 503 Service Unavailable
- 記錄簡潔的錯誤日誌（避免重複堆疊）

**未來改進建議：**
- 在返回 503 錯誤時，自動創建 `offline` 類型的警報記錄
- 根據離線時間長短，自動調整嚴重程度（warning → critical）

---

## API 使用範例

### 創建警報

```javascript
POST /api/alerts
Authorization: Bearer <token>
Content-Type: application/json

{
  "device_id": 1,
  "alert_type": "offline",
  "severity": "warning",
  "message": "感測器設備「展廳感測器」離線，無法讀取資料"
}
```

### 查詢警報

```javascript
GET /api/alerts?device_id=1&alert_type=offline&severity=warning&resolved=false&limit=20&offset=0&orderBy=created_at&order=desc
```

### 標記為已解決

```javascript
PUT /api/alerts/:id/resolve
Authorization: Bearer <token>
```

### 取得未解決警報數量

```javascript
GET /api/alerts/unresolved/count?device_id=1
```

---

## 資料庫結構

### device_alerts 表

| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | SERIAL | 主鍵 |
| `device_id` | INTEGER | 設備 ID（外鍵 → devices.id） |
| `alert_type` | alert_type | 警報類型（ENUM） |
| `severity` | alert_severity | 嚴重程度（ENUM） |
| `message` | TEXT | 警報訊息 |
| `resolved` | BOOLEAN | 是否已解決（預設 false） |
| `resolved_at` | TIMESTAMP | 解決時間 |
| `resolved_by` | INTEGER | 解決者用戶 ID（外鍵 → users.id） |
| `created_at` | TIMESTAMP | 創建時間 |

### ENUM 類型定義

```sql
-- 警報類型
CREATE TYPE alert_type AS ENUM ('offline', 'error', 'threshold', 'maintenance');

-- 嚴重程度
CREATE TYPE alert_severity AS ENUM ('info', 'warning', 'error', 'critical');
```

---

## 測試工具

### 創建測試警報

```bash
npm run alerts:create-test
```

此腳本會：
1. 查找第一個啟用的感測器設備
2. 創建 5 個不同類型和嚴重程度的測試警報
3. 用於測試前端警報列表顯示功能

---

## 未來擴展建議

### 1. 自動警報創建

- **感測器離線：** 當檢測到 503 錯誤時，自動創建 `offline` 警報
- **閾值監控：** 當感測器數值超過設定閾值時，自動創建 `threshold` 警報
- **定期維護：** 根據設備最後維護時間，自動創建 `maintenance` 警報

### 2. 警報升級機制

- 當 `offline` 警報持續超過 1 小時，自動升級為 `critical`
- 當 `threshold` 警報持續超過 30 分鐘，自動升級嚴重程度

### 3. 通知機制

- 整合郵件通知
- 整合簡訊通知（針對 critical 級別）
- 整合推播通知

### 4. 設備型號特定警報

- 為特定設備型號定義專屬的警報規則
- 例如：某些型號的感測器可能有特定的閾值範圍

---

## 相關文件

- [資料庫文檔](./DATABASE_DOCUMENTATION.md) - 查看完整的資料庫結構
- [API 文檔](./API_DOCUMENTATION.md) - 查看完整的 API 說明
- [架構概覽](./ARCHITECTURE_OVERVIEW.md) - 查看系統架構設計

