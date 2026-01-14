# 監控系統說明文檔

**最後更新**：2025-01-08  
**適用版本**：後端 v1.0+

---

## 📋 目錄

1. [系統概述](#系統概述)
2. [監控任務](#監控任務)
3. [配置說明](#配置說明)
4. [故障處理](#故障處理)
5. [擴展指南](#擴展指南)

---

## 系統概述

### 核心組件

1. **背景監控服務** (`backgroundMonitor.js`) - 統一管理所有監控任務，並行執行
2. **環境系統監控** (`environmentMonitor.js`) - 監控感測器狀態，檢查閾值規則
3. **照明系統監控** (`lightingMonitor.js`) - 監控設備連線狀態
4. **錯誤追蹤服務** (`errorTracker.js`) - 累積錯誤次數，觸發離線警報

### 監控頻率

- **監控間隔**：每 15 秒執行一次
- **執行時間**：約 10 秒內完成
- **任務數**：2 個（環境系統、照明系統）

### 系統特點

- ✅ **並行執行**：所有監控任務並行執行，提高效率
- ✅ **錯誤隔離**：單個任務失敗不影響其他任務
- ✅ **狀態追蹤**：只在狀態改變時推送 WebSocket 事件
- ✅ **自動恢復**：設備恢復連線時自動解決警報
- ✅ **重疊保護**：如果上次執行還在進行中，跳過本次執行

---

## 監控任務

### 1. 環境系統監控

**功能**：監控所有環境位置的感測器設備狀態，檢查感測器數值是否超過閾值。

**流程**：

1. 查詢環境位置（只查詢 active 狀態的感測器設備）
2. 並行檢查所有位置
3. 讀取感測器數據（優先從資料庫 `sensor_readings`，如果沒有則通過 Modbus）
4. 檢查閾值規則（使用緩存）
5. 創建或更新閾值警報
6. 自動解決恢復的警報（數值恢復正常時）

**檢查的參數**：PM2.5、PM10、CO2、溫度、濕度、噪音值、TVOC、HCHO、風速

**觸發的警報**：閾值警報 (`threshold`)

### 2. 照明系統監控

**功能**：監控所有照明區域的設備狀態，檢查設備連線狀態。

**流程**：

1. 查詢照明區域（只查詢有 Modbus 配置的區域）
2. 並行檢查所有區域
3. 檢查設備連線（通過 Modbus 讀取數據）
4. 錯誤追蹤（`errorTracker`）
5. 觸發離線警報（達到閾值時）
6. 自動解決警報（設備恢復連線時）

**觸發的警報**：離線警報 (`offline`) - 設備連續 5 次連接失敗時創建

---

## 配置說明

### 環境變數

- `MONITORING_ENABLED` - 是否啟用背景監控服務（預設：`true`）
- `ENABLE_DETAILED_LOGS` - 是否啟用詳細日誌輸出（預設：`false`）

### 監控間隔

監控間隔在 `backgroundMonitor.js` 中定義為 15 秒（執行時間約 10 秒，確保任務有足夠時間完成）。

---

## 故障處理

### 常見問題

#### 1. 監控任務執行時間過長

**症狀**：日誌顯示「上次監控任務仍在執行中，跳過本次執行」

**可能原因**：設備響應緩慢、資料庫查詢過慢、監控的位置/區域數量過多

**解決方案**：檢查設備連接狀態和資料庫性能

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
SELECT * FROM alerts WHERE source = 'environment' AND alert_type = 'threshold' AND status = 'ignored';

-- 檢查規則是否啟用
SELECT * FROM alert_rules WHERE source = 'environment' AND enabled = TRUE;

-- 檢查最新的感測器讀數
SELECT data, timestamp FROM sensor_readings WHERE location_id = ? ORDER BY timestamp DESC LIMIT 1;
```

#### 3. 設備離線警報沒有被創建

**症狀**：設備連接失敗，但沒有創建離線警報

**可能原因**：

- 錯誤次數未達到閾值（需要連續 5 次失敗）
- 警報已被忽視

**檢查方法**：

```sql
-- 檢查錯誤追蹤記錄
SELECT * FROM error_tracking WHERE source = 'lighting' AND source_id = ?;

-- 檢查是否有被忽視的警報
SELECT * FROM alerts WHERE source = 'lighting' AND alert_type = 'offline' AND status = 'ignored';
```

#### 4. 規則緩存問題

**症狀**：更新規則後，系統仍使用舊規則

**解決方案**：重啟服務（自動清除緩存）或手動調用 `alertRuleService.clearThresholdRulesCache()`

---

## 擴展指南

### 添加新的監控任務

1. **創建監控任務文件**（例如：`newSystemMonitor.js`）

   ```javascript
   async function checkNewSystem() {
     // 查詢需要監控的資源
     // 並行檢查所有資源
     // 創建/更新警報
     // 解決恢復的警報
   }

   module.exports = {
     checkNewSystem,
   };
   ```

2. **在 `server.js` 中註冊**：

   ```javascript
   const newSystemMonitor = require("./services/monitoring/newSystemMonitor");

   backgroundMonitor.registerMonitoringTask(
     "新系統",
     newSystemMonitor.checkNewSystem
   );
   ```

3. **可選：自定義監控間隔**：
   ```javascript
   backgroundMonitor.registerMonitoringTask(
     "新系統",
     newSystemMonitor.checkNewSystem,
     30000 // 30 秒間隔（可選）
   );
   ```

---

**文檔結束**
