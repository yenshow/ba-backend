# 監控系統說明文檔

**最後更新**：2026-01-20  
**適用版本**：後端 v1.0+

---

## 📋 目錄

1. [系統概述](#系統概述)
2. [架構設計](#架構設計)
3. [監控任務詳解](#監控任務詳解)
4. [配置說明](#配置說明)
5. [故障處理](#故障處理)
6. [擴展指南](#擴展指南)

---

## 系統概述

### 核心組件

1. **背景監控服務** (`backgroundMonitor.js`) - 統一管理所有監控任務，並行執行
2. **環境系統監控** (`environmentMonitor.js`) - 監控感測器狀態，檢查閾值規則
3. **照明系統監控** (`lightingMonitor.js`) - 監控設備連線狀態
4. **人流統計系統監控** (`peopleCountingMonitor.js`) - 監控刷卡記錄，檢測未註冊人員並推送即時更新
5. **錯誤追蹤服務** (`errorTracker.js`) - 累積錯誤次數，觸發離線警報

### 監控頻率

- **監控間隔**：每 15 秒執行一次
- **執行時間**：約 10 秒內完成
- **任務數**：3 個（環境系統、照明系統、人流統計系統）

### 系統特點

- ✅ **並行執行**：所有監控任務並行執行，提高效率
- ✅ **錯誤隔離**：單個任務失敗不影響其他任務
- ✅ **狀態追蹤**：只在狀態改變時推送 WebSocket 事件（適用於設備狀態監控）
- ✅ **自動恢復**：設備恢復連線時自動解決警報
- ✅ **重疊保護**：如果上次執行還在進行中，跳過本次執行
- ✅ **批次處理**：設備狀態監控使用批次推送，減少 WebSocket 事件數量
- ✅ **結構化日誌**：統一使用 logger 進行日誌記錄，支持日誌級別和模組標記

---

## 架構設計

### 設計原則

所有監控系統遵循以下設計原則：

#### 1. 統一錯誤處理

- **錯誤捕獲**：監控任務內部錯誤由 `backgroundMonitor` 統一捕獲和處理
- **錯誤記錄**：任務函數不應重新拋出錯誤，只需使用 `logger.error()` 記錄錯誤日誌
- **錯誤隔離**：單個資源檢查失敗不影響其他資源的檢查
- **錯誤追蹤**：`backgroundMonitor` 會追蹤每個任務的錯誤次數，連續 5 次失敗時會記錄警告

**實作範例**：

```javascript
async function checkNewSystem() {
  try {
    // 監控邏輯
  } catch (error) {
    logger.error("檢查新系統失敗", {
      error,
      module: "newSystemMonitor",
    });
    // 不重新拋出錯誤，由 backgroundMonitor 統一處理
  }
}
```

#### 2. 統一日誌記錄

- **使用 logger**：所有監控系統統一使用 `logger` 進行結構化日誌記錄
- **日誌級別**：
  - `logger.error()` - 錯誤訊息
  - `logger.warn()` - 警告訊息
  - `logger.info()` - 一般資訊（如檢查完成統計）
  - `logger.debug()` - 調試訊息（需設置 `ENABLE_DETAILED_LOGS=true`）
- **模組標記**：所有日誌都包含 `module` 標記，便於追蹤和過濾
- **結構化元數據**：日誌包含相關的上下文信息（如 deviceId、locationId 等）

**實作範例**：

```javascript
const logger = require("../../utils/logger");

// 錯誤日誌
logger.error("記錄設備數值失敗", {
  error: error.message,
  deviceId,
  module: "environmentMonitor",
});

// 資訊日誌
logger.info(`檢查完成: 成功 ${successCount} 個，失敗 ${failCount} 個`, {
  successCount,
  failCount,
  module: "environmentMonitor",
});

// 調試日誌（僅在啟用詳細日誌時輸出）
if (process.env.ENABLE_DETAILED_LOGS === "true") {
  logger.debug("感測器數據", {
    locationId,
    sensorData,
    module: "environmentMonitor",
  });
}
```

#### 3. 批次推送優化

- **設備狀態監控**（環境、照明）：
  - 使用 `lastDeviceStatus` Map 追蹤設備狀態
  - 只在狀態改變時才推送 WebSocket 事件
  - 使用 `emitBatchDeviceStatus()` 批次推送，減少事件數量
- **事件驅動監控**（人流統計）：
  - 每筆新記錄立即推送
  - 使用 `emitPeopleCountingRecord()` 即時推送

#### 4. 處理模式差異

| 模式 | 適用場景 | 實作方式 | 範例 |
|------|---------|---------|------|
| **並行處理** | 設備狀態監控 | `Promise.allSettled()` | 環境系統、照明系統 |
| **順序處理** | 事件流監控 | `for...of` 循環 | 人流統計系統 |

**設計說明**：
- **並行處理**：適合需要同時檢查多個設備的場景，提高效率
- **順序處理**：適合需要按時間順序處理事件的場景，確保順序正確

### 監控系統架構對比

| 特性 | 環境系統 | 照明系統 | 人流統計系統 |
|------|---------|---------|-------------|
| **處理模式** | 並行處理 | 並行處理 | 順序處理 |
| **狀態追蹤** | ✅ 有 | ✅ 有 | ❌ 無（事件驅動） |
| **批次推送** | ✅ 是 | ✅ 是 | ❌ 否（即時推送） |
| **錯誤處理** | logger.error | logger.error | logger.error |
| **日誌記錄** | logger | logger | logger |
| **資料來源** | 內部資料庫 + Modbus | 內部資料庫 + Modbus | 外部資料庫 |
| **警報類型** | 閾值警報 | 離線警報 | 未註冊人員警報 |
| **WebSocket 事件** | `monitoring:device:status:batch` | `monitoring:device:status:batch` | `people_counting:record:new` |

---

## 監控任務詳解

### 1. 環境系統監控

**功能**：監控所有環境位置的感測器設備狀態，檢查感測器數值是否超過閾值。

**流程**：

1. 查詢環境位置（只查詢 active 狀態的感測器設備）
2. 並行檢查所有位置（使用 `Promise.allSettled`）
3. 讀取感測器數據（透過 Modbus 讀取，並自動記錄到 `device_data_logs`）
4. 從 `device_data_logs` 獲取最新數值進行閾值檢查
5. 檢查閾值規則（使用緩存）
6. 創建或更新閾值警報
7. 自動解決恢復的警報（數值恢復正常時）
8. 批次推送設備狀態更新（只在狀態改變時）

**檢查的參數**：PM2.5、PM10、CO2、溫度、濕度、噪音值、TVOC、HCHO、風速

**觸發的警報**：閾值警報 (`threshold`)

**WebSocket 事件**：`monitoring:device:status:batch`

### 2. 照明系統監控

**功能**：監控所有照明區域的設備狀態，檢查設備連線狀態。

**流程**：

1. 查詢照明區域（只查詢有 Modbus 配置的區域）
2. 並行檢查所有區域（使用 `Promise.allSettled`）
3. 檢查設備連線（通過 Modbus 讀取數據）
4. 錯誤追蹤（`errorTracker`）
5. 觸發離線警報（達到閾值時）
6. 自動解決警報（設備恢復連線時）
7. 批次推送設備狀態更新（只在狀態改變時）

**觸發的警報**：離線警報 (`offline`) - 設備連續 5 次連接失敗時創建

**WebSocket 事件**：`monitoring:device:status:batch`

### 3. 人流統計系統監控

**功能**：監控外部資料庫的刷卡記錄，檢測未註冊人員並即時推送新記錄給前端。

**流程**：

1. 查詢自上次檢查後的新刷卡記錄（基於 `swip_card_rev_time`）
2. 取得所有人流統計地點配置
3. 為每筆記錄（順序處理）：
   - 檢查是否為未註冊人員（`person_id = -1`），如果是則創建警報
   - 判斷事件類型（entry/exit）基於 `physical_id` 匹配入口/出口設備
   - 通過 WebSocket 推送新記錄事件（`people_counting:record:new`）

**檢查的資料**：
- 刷卡記錄（`baseacs.slot_card_records`）
- 人員資訊（`platform.person`）
- 單位資訊（`platform.person_group`）

**觸發的警報**：未註冊人員警報 (`error`) - 當檢測到 `person_id = -1` 的記錄時自動創建

**WebSocket 事件**：`people_counting:record:new`

---

## 配置說明

### 環境變數

| 變數名稱 | 說明 | 預設值 | 備註 |
|---------|------|--------|------|
| `MONITORING_ENABLED` | 是否啟用背景監控服務 | `true` | 設置為 `false` 可停用所有監控任務 |
| `ENABLE_DETAILED_LOGS` | 是否啟用詳細日誌輸出 | `false` | 設置為 `true` 會輸出調試日誌 |

### 監控間隔

監控間隔在 `backgroundMonitor.js` 中定義為 15 秒：

```javascript
const MONITORING_INTERVAL = 15000; // 15 秒
```

**設計考量**：
- 執行時間約 10 秒
- 設置 15 秒間隔確保任務有足夠時間完成
- 避免任務重疊執行

### 自定義監控間隔

如果需要為特定監控任務設置不同的間隔，可以在註冊時指定：

```javascript
backgroundMonitor.registerMonitoringTask(
  "新系統",
  newSystemMonitor.checkNewSystem,
  30000 // 30 秒間隔（可選）
);
```

---

## 故障處理

### 常見問題

#### 1. 監控任務執行時間過長

**症狀**：日誌顯示「上次監控任務仍在執行中，跳過本次執行」

**可能原因**：
- 設備響應緩慢
- 資料庫查詢過慢
- 監控的位置/區域數量過多

**解決方案**：
- 檢查設備連接狀態
- 檢查資料庫性能
- 考慮增加監控間隔或優化查詢

#### 2. 警報沒有被創建

**症狀**：感測器數值超過閾值，但沒有創建警報

**可能原因**：
- 警報已被忽視
- 規則未啟用
- 參數名稱不匹配
- 感測器數據格式錯誤

**檢查方法**：

```sql
-- 檢查是否有被忽視的警報
SELECT * FROM alerts 
WHERE source = 'environment' 
  AND alert_type = 'threshold' 
  AND status = 'ignored';

-- 檢查規則是否啟用
SELECT * FROM alert_rules 
WHERE source = 'environment' 
  AND enabled = TRUE;

-- 檢查最新的設備數值記錄
SELECT 
  recorded_at as timestamp,
  jsonb_object_agg(value->>'name', (value->>'value')::numeric) as data
FROM device_data_logs
WHERE device_id = (
  SELECT (system_config->>'device_id')::integer 
  FROM location_systems 
  WHERE location_id = ? AND system_type = 'environment'
)
GROUP BY date_trunc('second', recorded_at)
ORDER BY timestamp DESC 
LIMIT 1;
```

#### 3. 設備離線警報沒有被創建

**症狀**：設備連接失敗，但沒有創建離線警報

**可能原因**：
- 錯誤次數未達到閾值（需要連續 5 次失敗）
- 警報已被忽視

**檢查方法**：

```sql
-- 檢查錯誤追蹤記錄
SELECT * FROM error_tracking 
WHERE source = 'lighting' 
  AND source_id = ?;

-- 檢查是否有被忽視的警報
SELECT * FROM alerts 
WHERE source = 'lighting' 
  AND alert_type = 'offline' 
  AND status = 'ignored';
```

#### 4. 規則緩存問題

**症狀**：更新規則後，系統仍使用舊規則

**解決方案**：
- 重啟服務（自動清除緩存）
- 或手動調用 `alertRuleService.clearThresholdRulesCache()`

#### 5. 人流統計監控沒有推送新記錄

**症狀**：資料庫有新記錄，但前端沒有收到 WebSocket 事件

**可能原因**：
- 監控任務執行失敗（檢查日誌中的錯誤訊息）
- 記錄的 `physical_id` 沒有對應到任何地點配置
- 外部資料庫連接問題
- WebSocket 連接未建立

**檢查方法**：

```sql
-- 檢查最近的刷卡記錄
SELECT 
  person_id,
  physical_id,
  swip_card_rev_time,
  is_deleted
FROM baseacs.slot_card_records
WHERE swip_card_rev_time > NOW() - INTERVAL '1 hour'
ORDER BY swip_card_rev_time DESC
LIMIT 10;

-- 檢查是否有未註冊人員記錄
SELECT COUNT(*) 
FROM baseacs.slot_card_records
WHERE person_id = -1 
  AND is_deleted = false
  AND swip_card_rev_time > NOW() - INTERVAL '24 hours';
```

**解決方案**：
- 檢查後端日誌中的錯誤訊息（使用 `logger.error` 記錄）
- 確認地點配置中的 `entryDoorId` 和 `exitDoorId` 是否正確
- 確認外部資料庫連接正常
- 檢查前端 WebSocket 連接狀態

---

## 擴展指南

### 添加新的監控任務

#### 1. 創建監控任務文件

創建新文件（例如：`src/services/monitoring/newSystemMonitor.js`）：

```javascript
/**
 * 新系統監控任務
 * 定期檢查新系統的狀態
 */

const db = require("../../database/db");
const logger = require("../../utils/logger");
const alertService = require("../alerts/alertService");
const websocketService = require("../websocket/websocketService");

/**
 * 檢查新系統狀態
 */
async function checkNewSystem() {
  try {
    // 1. 查詢需要監控的資源
    const resources = await db.query(`
      SELECT id, name, status
      FROM new_system_resources
      WHERE status = 'active'
    `);

    if (resources.length === 0) {
      return;
    }

    let successCount = 0;
    let failCount = 0;

    // 2. 並行檢查所有資源（或順序處理，根據需求）
    const checkPromises = resources.map(async (resource) => {
      try {
        // 檢查邏輯
        const isHealthy = await checkResourceHealth(resource);

        if (isHealthy) {
          successCount++;
          // 清除錯誤狀態
          await alertService.updateAlertStatus(
            resource.id,
            alertService.ALERT_SOURCES.NEW_SYSTEM,
            "offline",
            alertService.ALERT_STATUS.RESOLVED
          );
        } else {
          failCount++;
          // 創建警報
          await alertService.createAlert({
            source: alertService.ALERT_SOURCES.NEW_SYSTEM,
            source_id: resource.id,
            alert_type: alertService.ALERT_TYPES.ERROR,
            severity: alertService.SEVERITIES.WARNING,
            message: `資源 ${resource.name} 狀態異常`,
          });
        }

        return { resourceId: resource.id, success: isHealthy };
      } catch (error) {
        failCount++;
        logger.error(`檢查資源 ${resource.id} 失敗`, {
          error: error.message,
          resourceId: resource.id,
          module: "newSystemMonitor",
        });
        return { resourceId: resource.id, success: false };
      }
    });

    const results = await Promise.allSettled(checkPromises);

    // 3. 批次推送狀態更新（如果需要）
    // const statusUpdates = [];
    // ... 收集狀態更新
    // if (statusUpdates.length > 0) {
    //   websocketService.emitBatchDeviceStatus(statusUpdates);
    // }

    // 4. 記錄檢查結果
    if (successCount > 0 || failCount > 0) {
      logger.info(`檢查完成: 成功 ${successCount} 個，失敗 ${failCount} 個`, {
        successCount,
        failCount,
        module: "newSystemMonitor",
      });
    }
  } catch (error) {
    logger.error("檢查新系統失敗", {
      error,
      module: "newSystemMonitor",
    });
    // 不重新拋出錯誤，由 backgroundMonitor 統一處理
  }
}

/**
 * 檢查資源健康狀態
 */
async function checkResourceHealth(resource) {
  // 實作檢查邏輯
  return true;
}

module.exports = {
  checkNewSystem,
};
```

#### 2. 在 server.js 中註冊

```javascript
const newSystemMonitor = require("./services/monitoring/newSystemMonitor");

if (process.env.MONITORING_ENABLED !== "false") {
  backgroundMonitor.registerMonitoringTask(
    "新系統",
    newSystemMonitor.checkNewSystem
  );
}
```

#### 3. 可選：自定義監控間隔

```javascript
backgroundMonitor.registerMonitoringTask(
  "新系統",
  newSystemMonitor.checkNewSystem,
  30000 // 30 秒間隔（可選）
);
```

### 最佳實踐

1. **錯誤處理**：
   - 使用 `try-catch` 包裹主要邏輯
   - 使用 `logger.error()` 記錄錯誤，不重新拋出
   - 單個資源檢查失敗不影響其他資源

2. **日誌記錄**：
   - 統一使用 `logger` 進行日誌記錄
   - 所有日誌都包含 `module` 標記
   - 關鍵操作使用適當的日誌級別

3. **並行處理**：
   - 如果檢查多個資源，使用 `Promise.allSettled()` 並行處理
   - 確保單個資源檢查失敗不影響其他資源

4. **狀態追蹤**（適用於設備狀態監控）：
   - 使用 Map 追蹤設備狀態
   - 只在狀態改變時推送 WebSocket 事件
   - 使用批次推送減少事件數量

5. **警報處理**：
   - 檢查失敗時創建警報
   - 恢復正常時自動解決警報
   - 使用適當的警報類型和嚴重程度

---

**文檔結束**
