# 後端架構完整分析

## 概述

本系統是一個**建築自動化（BA）系統後端**，整合了多個子系統，提供統一的資料管理、監控和警報功能。

---

## 核心資料表分類

### 1. 設備相關資料表

#### `device_data_logs` - 設備資料歷史記錄

**用途：** 儲存設備的實際數值（處理後的、有意義的數值），而非 Modbus 暫存器的原始讀數

**資料特性：**

- **高頻率記錄**：定期輪詢設備並記錄實際數值（可配置間隔，預設 60 秒）
- **時間序列**：按時間順序記錄，用於歷史趨勢分析
- **處理後的資料**：儲存轉換後的實際數值（如：溫度 25.5°C、PM2.5 35 μg/m³）
- **設備級別**：以設備為單位記錄，由監控服務自動寫入
- **批次寫入**：100 筆/批次，5 秒刷新間隔，非阻塞設計

**表結構：**

```sql
device_data_logs (
  id BIGSERIAL,
  device_id INTEGER,        -- 設備 ID
  register_type register_type, -- Modbus 暫存器類型
  address INTEGER,           -- 暫存器地址
  value JSONB,               -- 實際數值（JSON 格式：{name, value, unit, timestamp}）
  recorded_at TIMESTAMP      -- 記錄時間
)
```

**數值轉換流程：**

1. 從 Modbus 讀數提取數值
2. 套用轉換公式（如：`value / 10`）
3. 套用縮放和偏移（可選）
4. 套用單位轉換（如：°C、%、μg/m³）
5. 儲存為有意義的實際數值

**配置範例：**

```json
{
  "logging": {
    "enabled": true,
    "interval": 60,
    "values": [
      {
        "name": "temperature",
        "register_type": "holding",
        "address": 0,
        "conversion": {
          "formula": "value / 10",
          "unit": "°C"
        },
        "enabled": true
      }
    ]
  }
}
```

**備份策略：**

- 備份位置：`backups/device_logs/`
- 備份條件：`recorded_at < 30天前`
- 備份格式：JSON + CSV
- **用途**：保留歷史資料用於趨勢分析和報表

**與 sensor_readings 的區別（已統一使用 device_data_logs）：**

- ~~`sensor_readings`~~（已廢棄）：原用於環境系統的位置級別讀數，現已統一改為使用 `device_data_logs`
- `device_data_logs`：設備級別，由監控服務自動寫入，記錄所有設備的實際數值
  - 查詢時按時間點聚合多個數值記錄為完整的讀數格式（向後兼容前端 API）
  - 支援環境系統的趨勢圖查詢和閾值檢查

---

### 2. 警報相關資料表

#### `alerts` - 統一警報系統

**用途：** 儲存各種系統產生的警報事件（事件驅動）

**資料特性：**

- **事件驅動**：當異常發生時才建立記錄
- **需要處理**：警報有狀態（active/resolved/ignored）
- **多系統來源**：支援設備、環境、照明、人流統計等系統

**表結構：**

```sql
alerts (
  id SERIAL,
  source alert_source,       -- 來源：device/environment/lighting/people_counting
  source_id INTEGER,         -- 來源 ID（設備 ID 或系統 ID）
  alert_type alert_type,     -- 警報類型：offline/error/threshold
  severity alert_severity,    -- 嚴重程度：warning/error/critical
  message TEXT,              -- 警報訊息
  status alert_status,       -- 當前狀態：active/resolved/ignored
  resolved_at TIMESTAMP,     -- 解決時間（最後一次）
  resolved_by INTEGER,       -- 解決者（最後一次）
  ignored_at TIMESTAMP,     -- 忽視時間（最後一次）
  ignored_by INTEGER,       -- 忽視者（最後一次）
  created_at TIMESTAMP,
  updated_at TIMESTAMP
)
```

**備份策略：**

- 備份位置：`backups/alerts/`
- 備份條件：`status = 'resolved' AND resolved_at < 30天前`
- 備份格式：JSON + CSV
- **用途**：保留已解決的警報歷史，用於審計和分析

## 核心區別對比

| 特性         | `device_data_logs`                  | `alerts`             |
| ------------ | ----------------------------------- | -------------------- |
| **資料性質** | 時間序列資料                        | 事件資料             |
| **記錄頻率** | 高頻（定期輪詢，可配置）            | 低頻（事件觸發）     |
| **資料內容** | 處理後的實際數值（如：25.5°C、60%） | 異常事件訊息         |
| **資料量**   | 大量（可能數百萬筆）                | 少量（數百到數千筆） |
| **用途**     | 歷史趨勢分析、報表                  | 異常監控、審計       |
| **生命週期** | 定期清理舊資料（30 天）             | 保留已解決的警報     |
| **備份目的** | 保留歷史資料用於分析                | 保留警報歷史用於審計 |

---

## 後端架構分類

### 1. 資料層（Database Layer）

#### 核心資料表

- **設備管理**

  - `devices` - 設備基本資訊
  - `device_types` - 設備類型
  - `device_models` - 設備型號
  - `device_data_logs` - 設備資料歷史記錄 ⭐

- **警報系統**

  - `alerts` - 統一警報表 ⭐
  - `alert_rules` - 警報規則
  - `error_tracking` - 錯誤追蹤

- **地點管理**

  - `zones` - 區域
  - `locations` - 地點
  - `location_systems` - 地點系統關聯

- **系統資料**

  - `lighting_categories` - 照明分類點
  - **注意**：感測器讀數已統一使用 `device_data_logs` 表（設備級別記錄）

- **用戶管理**
  - `users` - 用戶帳號

#### 外部資料表（External Database）

- `baseacs-slot_card_records` - 刷卡記錄
- `platform-person` - 人員資料
- `platform-person_group` - 人員群組
- `platform-person_head_pic` - 人員頭像

---

### 2. 服務層（Service Layer）

#### 設備服務 (`src/services/devices/`)

- `deviceService.js` - 設備 CRUD 操作
- `deviceTypeService.js` - 設備類型管理
- `deviceModelService.js` - 設備型號管理
- `modbusClient.js` - Modbus 通訊客戶端
- `deviceDataLogger.js` - 設備資料記錄服務（批次寫入、數值轉換）⭐

#### 警報服務 (`src/services/alerts/`)

- `alertService.js` - 警報 CRUD、狀態管理
- `alertRuleService.js` - 警報規則管理
- `alertCleanupService.js` - 自動清理服務（備份）
- `errorTracker.js` - 錯誤追蹤
- `systemAlertHelper.js` - 系統警報輔助

#### 監控服務 (`src/services/monitoring/`)

- `backgroundMonitor.js` - 背景監控（輪詢設備資料）
- `environmentMonitor.js` - 環境監控（已整合 device_data_logs）
- `lightingMonitor.js` - 照明監控（已整合 device_data_logs）

#### 系統服務 (`src/services/systems/`)

- `environmentService.js` - 環境系統服務
- `lightingService.js` - 照明系統服務
- `peopleCountingService.js` - 人流統計服務
- `locationService.js` - 地點管理服務

#### 外部資料服務 (`src/services/externalData/`)

- `baseExternalDataService.js` - 外部資料服務基類
- `handlerFactory.js` - 處理器工廠
- `handlers/` - 各種外部資料處理器

#### 通訊服務 (`src/services/communication/`)

- `mediaMTXService.js` - MediaMTX 串流服務

#### 備份服務 (`src/services/backup/`)

- `backupService.js` - 統一備份服務核心
- `backupConfig.js` - 備份配置管理
- `backupFormats.js` - 備份格式處理
- `backupScheduler.js` - 定時備份任務

#### WebSocket 服務 (`src/services/websocket/`)

- `websocketService.js` - WebSocket 即時通訊

#### 用戶服務

- `userService.js` - 用戶管理

---

### 3. 路由層（Route Layer）

#### API 路由 (`src/routes/`)

- `userRoutes.js` - 用戶相關 API
- `deviceRoutes.js` - 設備相關 API
- `modbusRoutes.js` - Modbus 相關 API
- `alertRoutes.js` - 警報相關 API
- `environmentRoutes.js` - 環境系統 API
- `lightingRoutes.js` - 照明系統 API
- `peopleCountingRoutes.js` - 人流統計 API
- `locationRoutes.js` - 地點管理 API
- `rtspRoutes.js` - RTSP 串流 API
- `externalDataRoutes.js` - 外部資料 API

---

### 4. 中間件層（Middleware Layer）

#### (`src/middleware/`)

- `authMiddleware.js` - 身份驗證
- `errorHandler.js` - 錯誤處理
- `responseHandler.js` - 回應處理
- `validation.js` - 資料驗證
- `common.js` - 通用中間件

---

### 5. 工具層（Utils Layer）

#### (`src/utils/`)

- `logger.js` - 日誌記錄
- `deviceHelpers.js` - 設備工具函數（含 logging 配置驗證）

---

## 資料流程分析

### device_data_logs 資料流程

```
背景監控服務 (每 15 秒)
    ↓
環境/照明監控
    ↓
Modbus 客戶端 (讀取資料)
    ↓
設備資料記錄服務 (deviceDataLogger.js)
    ├─ 讀取設備 logging 配置（含快取）
    ├─ 從 Modbus 讀數提取數值
    ├─ 套用轉換公式（如：value / 10）
    ├─ 套用單位轉換
    └─ 批次寫入 device_data_logs（實際數值）
    ↓
[定期備份] → backups/device_logs/
```

**核心服務：** `src/services/devices/deviceDataLogger.js`

- 批次寫入機制（100 筆/批次，5 秒刷新）
- 配置快取（5 分鐘過期）
- 數值轉換（公式、縮放、偏移、單位）
- 非阻塞設計（不影響監控效能）

---

### alerts 資料流程

```
監控服務 / 錯誤追蹤
    ↓
檢測到異常
    ↓
建立警報 (alertService.js)
    ↓
儲存到 alerts
    ↓
WebSocket 通知前端
    ↓
用戶處理（解決/忽視）
    ↓
[定期備份已解決的警報] → backups/alerts/
```

**特點：**

- 事件驅動：只在異常發生時建立
- 需要處理：用戶需要手動解決或忽視
- 多系統來源：設備、環境、照明、人流統計

---

## 備份系統分類

### 備份目標分類

| 備份類別       | 資料表             | 備份位置               | 備份條件                                     | 用途         |
| -------------- | ------------------ | ---------------------- | -------------------------------------------- | ------------ |
| **deviceLogs** | `device_data_logs` | `backups/device_logs/` | `recorded_at < 30天前`                       | 歷史趨勢分析 |
| **alerts**     | `alerts`           | `backups/alerts/`      | `status='resolved' AND resolved_at < 30天前` | 警報審計     |
| **cleanup**    | 其他表             | `backups/cleanup/`     | 資料庫清理時                                 | 安全備份     |

詳細備份系統說明請參考：`docs/BACKUP_SYSTEM.md`

---

## 系統整合架構

### 多系統整合

```
┌─────────────────────────────────────────┐
│         統一後端系統                      │
├─────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ 設備系統  │  │ 環境系統  │  │ 照明系統 │ │
│  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │             │             │      │
│       └─────────────┼─────────────┘      │
│                     │                    │
│              ┌──────▼──────┐            │
│              │ 統一警報系統  │            │
│              │   (alerts)   │            │
│              └─────────────┘            │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │   設備資料歷史 (device_data_logs) │  │
│  │   設備資料記錄服務 (deviceDataLogger)│ │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

## 總結

### alerts vs device_data_logs

1. **alerts（警報）**

   - 事件驅動，異常發生時建立
   - 需要用戶處理（解決/忽視）
   - 多系統來源整合
   - 備份已解決的警報用於審計

2. **device_data_logs（設備日誌）**
   - 時間序列，定期記錄（可配置間隔）
   - 處理後的實際數值（如：25.5°C、60%、35 μg/m³）
   - 設備級別，由監控服務自動寫入
   - 支援數值轉換（公式、縮放、偏移、單位）
   - 批次寫入（100 筆/批次），非阻塞設計
   - 用於歷史趨勢分析
   - 備份舊資料用於報表（30 天前）

### 備份策略

- **device_data_logs**：定期備份舊資料，保留用於趨勢分析
- **alerts**：備份已解決的警報，保留用於審計和歷史查詢

兩者都是重要的歷史資料，但用途不同，因此分開備份和管理。

---

## 相關文檔

- `docs/BACKUP_SYSTEM.md` - 備份系統完整文檔
