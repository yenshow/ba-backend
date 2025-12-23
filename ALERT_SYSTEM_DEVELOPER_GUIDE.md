# 警報系統開發者指南

## 概述

本指南提供警報系統的技術實現細節、架構設計、擴展方法和最佳實踐。

---

## 系統架構

### 後端架構

```
src/services/
├── alerts/                    # 警報相關服務
│   ├── alertService.js       # 統一警報服務（核心）
│   ├── errorTracker.js       # 錯誤追蹤服務（持久化）
│   ├── deviceErrorTracker.js # 設備錯誤追蹤適配器（向後兼容）
│   └── helpers/              # 警報輔助函數
│       ├── alertHelperBase.js     # 共用輔助函數
│       ├── environmentAlertHelper.js
│       └── lightingAlertHelper.js

src/routes/
└── alertRoutes.js            # 警報 API 路由

src/database/
└── initSchema.js          # 資料庫初始化（包含 alerts 和 error_tracking 表）
```

### 前端架構

```
app/
├── composables/
│   ├── useAlertApi.ts        # 警報 API 調用
│   └── useAlertMonitor.ts    # 警報監聽器
├── pages/system/
│   └── alert-log.vue         # 警示紀錄頁面
├── types/
│   └── alert.ts              # 類型定義
└── utils/
    └── alertUtils.ts         # 共用工具函數
```

---

## 核心服務說明

### 1. alertService.js（統一警報服務）

**功能：**

- 創建、查詢、更新警報
- 支持多系統來源
- 警報合併（相同來源、類型、狀態）
- 狀態機管理

**主要方法：**

```javascript
// 取得警報列表
getAlerts(filters) {
  // 支持 source, source_id, status, device_type_code 等篩選
  // 自動合併相同來源、類型、狀態的警報
  // 返回 device_name, device_type_name（通過 JOIN）
}

// 創建警報
createAlert(alertData) {
  // 驗證 source, alert_type, severity
  // 檢查是否已有相同警報（避免重複）
  // 如果已有，更新嚴重程度（取較高者）
}

// 更新警報狀態
updateAlertStatus(sourceId, source, alertType, newStatus, userId) {
  // 支持多系統來源
  // 更新 resolved_at/ignored_at 和對應用戶 ID
}

// 標記為已解決（向後兼容）
resolveAlert(sourceId, alertType, resolvedBy, source = 'device')

// 忽視警報（向後兼容）
ignoreAlerts(sourceId, alertType, ignoredBy, source = 'device')
```

### 2. errorTracker.js（錯誤追蹤服務）

**功能：**

- 持久化錯誤狀態到資料庫
- 連續錯誤計數
- 達到閾值時自動創建警報
- 支持多系統來源

**主要方法：**

```javascript
// 記錄錯誤
recordError(source, sourceId, alertType, errorMessage, metadata) {
  // 檢查是否已被忽視
  // 增加錯誤計數
  // 達到閾值（5次）時創建警報
  // 嚴重程度：5-9次=warning, 10次以上=critical
}

// 清除錯誤狀態
clearError(source, sourceId) {
  // 重置錯誤計數和警報標記
  // 當來源恢復正常時調用
}
```

### 3. deviceErrorTracker.js（設備錯誤追蹤適配器）

**功能：**

- 提供向後兼容的接口
- 內部使用 errorTracker.js
- 自動獲取設備資訊構建 metadata
- 支持從設備配置中提取設備 ID

**主要方法：**

```javascript
// 記錄設備錯誤（向後兼容）
recordDeviceError(deviceId, errorType, errorMessage);

// 清除設備錯誤（向後兼容）
clearDeviceError(deviceId);

// 取得設備錯誤狀態
getDeviceErrorState(deviceId);

// 從設備配置中提取設備 ID
getDeviceIdFromConfig(deviceConfig);

// 錯誤閾值常數
ERROR_THRESHOLD; // 預設為 5
```

---

## 前端實現

### 1. useAlertApi.ts（API 調用）

**功能：**

- 封裝所有警報相關的 API 調用
- 支持新的多系統來源參數
- 向後兼容舊的參數

**主要方法：**

```typescript
// 取得警示列表
getAlerts(filters?: AlertFilters): Promise<AlertListResponse>

// 標記為已解決（支持多系統來源）
resolveAlert(sourceId: number, alertType: string, source?: string)

// 忽視警示（支持多系統來源）
ignoreAlert(sourceId: number, alertType: string, source?: string)

// 取得未解決警報數量
getUnresolvedAlertCount(filters?: {...}): Promise<UnresolvedAlertCountResponse>
```

### 2. useAlertMonitor.ts（警報監聽器）

**功能：**

- 自動監聽新的未解決警報
- 每 10 秒輪詢一次
- 顯示 Toast 通知
- 避免重複通知

**使用方式：**

```typescript
// 在 default.vue layout 中
const { startMonitoring, stopMonitoring } = useAlertMonitor();

watch(
  () => user.value,
  (newUser) => {
    if (newUser) {
      startMonitoring(); // 用戶登入時啟動
    } else {
      stopMonitoring(); // 用戶登出時停止
    }
  }
);
```

### 3. alert-log.vue（警示紀錄頁面）

**功能：**

- 顯示警報列表
- 多種篩選功能
- 警報操作（解決、忽視、未解決）
- 分頁顯示

**篩選功能：**

- 狀態篩選：全部狀態、未解決、已解決、已忽視
- 系統來源篩選：全部系統、設備系統、環境系統、照明系統
- 設備類型篩選：全部設備、攝影機、感測器、控制器、平板、網路裝置
- 時間範圍篩選：開始日期 ~ 結束日期

---

## 資料庫設計

### 表結構

#### alerts 表

```sql
CREATE TABLE alerts (
  id SERIAL PRIMARY KEY,
  source alert_source NOT NULL,
  source_id INTEGER NOT NULL,
  source_type VARCHAR(50),
  alert_type alert_type NOT NULL,
  severity alert_severity NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  status alert_status NOT NULL DEFAULT 'active',
  metadata JSONB DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ignored_at TIMESTAMP,
  ignored_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_alerts_source_source_id ON alerts(source, source_id);
CREATE INDEX idx_alerts_status ON alerts(status);
CREATE INDEX idx_alerts_created_at ON alerts(created_at);
```

#### error_tracking 表

```sql
CREATE TABLE error_tracking (
  id SERIAL PRIMARY KEY,
  source alert_source NOT NULL,
  source_id INTEGER NOT NULL,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error_at TIMESTAMP,
  alert_created BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_id)
);

-- 索引
CREATE INDEX idx_error_tracking_source_source_id ON error_tracking(source, source_id);
```

### 查詢優化

**警報列表查詢：**

- 使用 `GROUP BY` 合併相同來源、類型、狀態的警報
- 使用 `LEFT JOIN` 獲取設備資訊和用戶資訊
- 使用子查詢獲取最新的 metadata（避免 MAX() 對 JSONB 的問題）

**性能考慮：**

- 已創建必要的索引
- 使用分頁限制查詢結果
- 合併查詢減少資料庫往返

---

## 為新系統添加警報支持

### alertHelperBase.js（共用輔助函數）

**功能：**

- 提供系統特定的警報創建、錯誤記錄和清除的通用函數
- 減少重複代碼，統一處理邏輯

**主要方法：**

```javascript
// 創建系統警報（通用函數）
createSystemAlert(
  source,
  sourceId,
  sourceType,
  getSourceInfo,
  alertType,
  severity,
  message,
  metadata
);

// 記錄系統錯誤（通用函數）
recordSystemError(source, sourceId, sourceType, getSourceInfo, errorMessage);

// 清除系統錯誤（通用函數）
clearSystemError(source, sourceId);
```

### 步驟 1: 創建輔助函數（可選）

```javascript
// src/services/alerts/helpers/hvacAlertHelper.js
const {
  createSystemAlert,
  recordSystemError,
  clearSystemError,
} = require("./alertHelperBase");
const alertService = require("../alertService");
const db = require("../../database/db");

/**
 * 獲取 HVAC 區域資訊
 */
async function getZoneInfo(zoneId) {
  const zone = await db.query(
    `SELECT z.id, z.name, f.name as floor_name
     FROM hvac_zones z
     INNER JOIN floors f ON z.floor_id = f.id
     WHERE z.id = ?`,
    [zoneId]
  );
  return zone && zone.length > 0 ? zone[0] : null;
}

/**
 * 創建 HVAC 警報
 */
async function createHvacAlert(
  zoneId,
  alertType,
  severity,
  message,
  metadata = {}
) {
  return await createSystemAlert(
    alertService.ALERT_SOURCES.HVAC,
    zoneId,
    "zone",
    getZoneInfo,
    alertType,
    severity,
    message,
    metadata
  );
}

/**
 * 記錄 HVAC 錯誤
 */
async function recordHvacError(zoneId, errorMessage) {
  return await recordSystemError(
    alertService.ALERT_SOURCES.HVAC,
    zoneId,
    "zone",
    getZoneInfo,
    errorMessage
  );
}

/**
 * 清除 HVAC 錯誤狀態
 */
async function clearHvacError(zoneId) {
  return await clearSystemError(alertService.ALERT_SOURCES.HVAC, zoneId);
}

module.exports = {
  createHvacAlert,
  recordHvacError,
  clearHvacError,
};
```

### 步驟 2: 在系統服務中集成

```javascript
// src/services/systems/hvacService.js
const hvacAlertHelper = require("../alerts/helpers/hvacAlertHelper");

// 當檢測到錯誤時
try {
  // ... 讀取數據 ...
} catch (error) {
  await hvacAlertHelper.recordHvacError(zoneId, "無法讀取溫度感測器");
  throw error;
}

// 當數值超過閾值時
if (temperature > threshold) {
  await hvacAlertHelper.createHvacAlert(
    zoneId,
    "threshold",
    "warning",
    `區域「${zoneName}」溫度超過閾值`,
    { parameter: "temperature", value: temperature, threshold }
  );
}

// 當恢復正常時
await hvacAlertHelper.clearHvacError(zoneId);
```

### 步驟 3: 更新前端（可選）

前端已支持多系統來源，無需額外修改。系統來源會自動顯示在警示紀錄頁面。

---

## 向後兼容

系統提供完整的向後兼容支持：

### API 參數兼容

```javascript
// 舊的 API 調用（仍然可用）
GET /api/alerts?device_id=1&resolved=false

// 自動轉換為
GET /api/alerts?source=device&source_id=1&status=active
```

### 服務方法兼容

```javascript
// 舊的方法調用（仍然可用）
await alertService.resolveAlert(deviceId, alertType, userId);

// 內部自動使用
await alertService.updateAlertStatus(
  deviceId,
  ALERT_SOURCES.DEVICE,
  alertType,
  ALERT_STATUS.RESOLVED,
  userId
);
```

---

## 最佳實踐

### 1. 創建警報時

- ✅ 提供清晰的 `message`
- ✅ 在 `metadata` 中包含相關資訊（設備名稱、位置等）
- ✅ 選擇適當的 `severity`
- ✅ 使用系統特定的輔助函數（如果可用）

### 2. 記錄錯誤時

- ✅ 使用 `errorTracker.recordError()` 而非直接創建警報
- ✅ 讓系統自動處理連續錯誤檢測
- ✅ 在來源恢復時調用 `clearError()`

### 3. 查詢警報時

- ✅ 使用 `status` 參數而非 `resolved`/`ignored`（新代碼）
- ✅ 使用 `source` 和 `source_id` 而非 `device_id`（新代碼）
- ✅ 合理使用分頁（`limit` 和 `offset`）

### 4. 前端開發時

- ✅ 使用 `useAlertApi` composable 而非直接調用 API
- ✅ 使用 `alertUtils` 工具函數獲取標籤和樣式
- ✅ 在需要監聽新警報時使用 `useAlertMonitor`

---

## 測試

### 創建測試警報

```bash
npm run alerts:create-test
```

### 手動測試 API

```bash
# 查詢警報
curl http://localhost:4000/api/alerts?status=active

# 創建警報
curl -X POST http://localhost:4000/api/alerts \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "device",
    "source_id": 1,
    "alert_type": "offline",
    "severity": "warning",
    "message": "測試警報"
  }'

# 標記為已解決
curl -X PUT http://localhost:4000/api/alerts/1/offline/resolve \
  -H "Authorization: Bearer <token>"
```

---

## 常見問題

### Q: 為什麼警報會自動合併？

A: 為了避免重複顯示相同的警報。系統會將相同來源、類型、狀態的警報合併為一條記錄，並顯示次數。

### Q: 如何區分不同系統的警報？

A: 使用 `source` 參數篩選，或在前端使用系統來源標籤。

### Q: 為什麼需要 `deviceErrorTracker.js`？

A: 這是向後兼容適配器，用於支持舊代碼。新代碼應該直接使用 `errorTracker.js`。

### Q: 前端監聽器會影響性能嗎？

A: 不會。監聽器每 10 秒輪詢一次，只查詢最近的 50 條未解決警報，對性能影響很小。

### Q: 如何自定義警報通知？

A: 修改 `useAlertMonitor.ts` 中的 `showAlertNotification()` 方法。

---

## 相關文檔

- [警報系統完整文檔](./ALERT_SYSTEM_DOCUMENTATION.md) - 功能說明和 API 文檔
- [資料庫文檔](./docs/DATABASE_DOCUMENTATION.md) - 查看完整的資料庫結構
- [API 文檔](./docs/API_DOCUMENTATION.md) - 查看完整的 API 說明
- [架構概覽](./docs/ARCHITECTURE_OVERVIEW.md) - 查看系統架構設計
