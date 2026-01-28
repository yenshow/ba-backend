# 資料庫 Schema 初始化文件說明

## 概述

`src/database/initSchema.js` 是資料庫 Schema 初始化腳本，負責建立整個系統所需的資料庫結構，包括資料表、ENUM 類型、索引、觸發器和預設資料。

## 執行方式

```bash
npm run db:init
```

或直接執行：

```bash
node src/database/initSchema.js
```

## 主要功能

### 1. 資料庫連接與建立

- 首先連接到 PostgreSQL 預設資料庫 `postgres`
- 檢查目標資料庫是否存在（從 `config.database.database` 讀取，預設為 `ba_system`）
- 如果不存在則建立目標資料庫
- 連接到目標資料庫進行後續操作

### 2. ENUM 類型定義

系統定義了以下 ENUM 類型：

#### 使用者相關
- **`user_role`**: `'admin'`, `'operator'`, `'viewer'`
- **`user_status`**: `'active'`, `'inactive'`, `'suspended'`

#### 設備相關
- **`device_status`**: `'active'`, `'inactive'`, `'error'`
- **`register_type`**: `'coil'`, `'discrete'`, `'holding'`, `'input'` (Modbus 暫存器類型)

#### 警報相關
- **`alert_type`**: `'offline'`, `'error'`, `'threshold'`
- **`alert_severity`**: `'warning'`, `'error'`, `'critical'`
- **`alert_source`**: `'device'`, `'environment'`, `'lighting'`, `'people_counting'`, `'hvac'`, `'fire'`, `'security'`
- **`alert_status`**: `'active'`, `'resolved'`, `'ignored'`

### 3. 資料表結構

#### 3.1 使用者管理

##### `users` 表
- **用途**: 儲存系統使用者資訊
- **主要欄位**:
  - `id`: 主鍵
  - `username`: 使用者名稱（唯一）
  - `email`: 電子郵件（唯一）
  - `password_hash`: 密碼雜湊
  - `role`: 角色（ENUM: user_role）
  - `status`: 狀態（ENUM: user_status）
  - `created_at`, `updated_at`: 時間戳記
- **索引**: `username`, `email`, `status`
- **觸發器**: 自動更新 `updated_at`

#### 3.2 設備管理

##### `device_types` 表
- **用途**: 設備類型定義（通用設備類型表）
- **主要欄位**:
  - `id`: 主鍵
  - `name`: 類型名稱（唯一）
  - `code`: 類型代碼（唯一）
  - `description`: 描述
- **預設資料**: 攝影機、感測器、控制器、平板、網路裝置

##### `device_models` 表
- **用途**: 設備型號定義（通用設備型號表）
- **主要欄位**:
  - `id`: 主鍵
  - `name`: 型號名稱
  - `type_id`: 設備類型 ID（外鍵）
  - `description`: 描述
  - `config`: JSONB 配置
  - `port`: Modbus 埠號（預設 502）
- **外鍵**: `type_id` → `device_types(id)`
- **索引**: `name`, `type_id`, `port`

##### `devices` 表
- **用途**: 設備實例
- **主要欄位**:
  - `id`: 主鍵
  - `name`: 設備名稱
  - `model_id`: 型號 ID（外鍵）
  - `type_id`: 類型 ID（外鍵）
  - `location`: 位置
  - `description`: 描述
  - `status`: 狀態（ENUM: device_status）
  - `config`: JSONB 配置
  - `last_seen_at`: 最後連線時間
  - `created_by`: 建立者 ID（外鍵）
- **外鍵**: 
  - `model_id` → `device_models(id)`
  - `type_id` → `device_types(id)`
  - `created_by` → `users(id)`
- **索引**: `status`, `type_id`, `model_id`, `config` (GIN)

##### `device_data_logs` 表
- **用途**: 設備資料記錄（統一設備數值記錄表）
- **主要欄位**:
  - `id`: 主鍵（BIGSERIAL）
  - `device_id`: 設備 ID（外鍵）
  - `register_type`: 暫存器類型（ENUM: register_type）
  - `address`: 暫存器地址
  - `value`: JSONB 數值
  - `recorded_at`: 記錄時間
- **外鍵**: `device_id` → `devices(id)` (ON DELETE CASCADE)
- **索引**: `(device_id, recorded_at)`, `recorded_at`

#### 3.3 警報系統

##### `alerts` 表（統一警報表）
- **用途**: 統一管理所有系統來源的警報
- **主要欄位**:
  - `id`: 主鍵
  - `source`: 警報來源（ENUM: alert_source）
  - `source_id`: 來源實體 ID
  - `alert_type`: 警報類型（ENUM: alert_type）
  - `severity`: 嚴重程度（ENUM: alert_severity）
  - `message`: 警報訊息
  - `status`: 狀態（ENUM: alert_status）
  - `resolved_at`: 解決時間
  - `resolved_by`: 解決者 ID（外鍵）
  - `ignored_at`: 忽略時間
  - `ignored_by`: 忽略者 ID（外鍵）
  - `created_at`, `updated_at`: 時間戳記
- **外鍵**: 
  - `resolved_by` → `users(id)`
  - `ignored_by` → `users(id)`
- **索引**:
  - `(source, source_id, alert_type, status)`: 複合索引
  - `(source, source_id, alert_type, status, created_at) WHERE status = 'active'`: 優化按天限制查詢
  - `(status, created_at DESC) WHERE status = 'active'`: 活躍警報查詢
  - `updated_at DESC`: 更新時間查詢
- **注意**: 已移除唯一索引 `unique_active_alert`，因為應用層實現了按天限制邏輯

##### `error_tracking` 表
- **用途**: 持久化錯誤狀態追蹤
- **主要欄位**:
  - `id`: 主鍵
  - `source`: 錯誤來源（ENUM: alert_source）
  - `source_id`: 來源實體 ID
  - `error_count`: 錯誤計數
  - `last_error_at`: 最後錯誤時間
  - `alert_created`: 是否已建立警報
  - `created_at`, `updated_at`: 時間戳記
- **唯一約束**: `(source, source_id)`
- **索引**: `(source, source_id)`, `alert_created`

##### `alert_rules` 表
- **用途**: 警報規則參照表
- **主要欄位**:
  - `id`: 主鍵
  - `source`: 警報來源（ENUM: alert_source）
  - `alert_type`: 警報類型（ENUM: alert_type）
  - `severity`: 嚴重程度（ENUM: alert_severity）
  - `condition_type`: 條件類型
  - `condition_config`: JSONB 條件配置
  - `message_template`: 訊息模板
  - `enabled`: 是否啟用
  - `created_at`, `updated_at`: 時間戳記
- **索引**: `(source, alert_type)`, `enabled`

#### 3.4 地點管理系統

##### `zones` 表（統一區域表）
- **用途**: 統一管理區域/樓層
- **主要欄位**:
  - `id`: 主鍵
  - `name`: 區域名稱（唯一）
  - `building_id`: 建築物 ID（可選）
  - `image_url`: 區域圖片 URL
  - `description`: 描述
  - `created_by`: 建立者 ID（外鍵）
  - `created_at`, `updated_at`: 時間戳記
- **外鍵**: `created_by` → `users(id)`
- **索引**: `name`, `building_id`

##### `locations` 表（統一地點表）
- **用途**: 統一管理物理地點（不包含系統相關資訊）
- **主要欄位**:
  - `id`: 主鍵
  - `zone_id`: 區域 ID（外鍵，必填）
  - `name`: 地點名稱
  - `description`: 描述
  - `created_by`: 建立者 ID（外鍵）
  - `created_at`, `updated_at`: 時間戳記
- **外鍵**: 
  - `zone_id` → `zones(id)` (ON DELETE CASCADE)
  - `created_by` → `users(id)`
- **唯一約束**: `(zone_id, name)` - 同一區域內地點名稱唯一
- **索引**: `zone_id`

##### `location_systems` 表（地點系統關聯表）
- **用途**: 關聯地點與系統配置
- **主要欄位**:
  - `id`: 主鍵
  - `location_id`: 地點 ID（外鍵）
  - `system_type`: 系統類型（CHECK: 'environment', 'lighting', 'people_counting'）
  - `system_config`: JSONB 系統配置
  - `created_at`, `updated_at`: 時間戳記
- **外鍵**: `location_id` → `locations(id)` (ON DELETE CASCADE)
- **唯一約束**: `(location_id, system_type)` - 同一地點的每種系統類型只能有一個配置
- **索引**: `location_id`, `system_type`, `system_config` (GIN)

#### 3.5 照明系統

##### `lighting_categories` 表
- **用途**: 照明系統分類點
- **主要欄位**:
  - `id`: 主鍵
  - `name`: 分類名稱
  - `zone_id`: 區域 ID（外鍵）
  - `location_x`, `location_y`: 位置座標（DECIMAL(5,2)）
  - `description`: 描述
  - `device_id`: 設備 ID（外鍵）
  - `modbus_config`: JSONB Modbus 配置
  - `room_ids`: 房間 ID 陣列
  - `status`: 狀態（預設 'active'）
  - `created_by`: 建立者 ID（外鍵）
  - `created_at`, `updated_at`: 時間戳記
- **外鍵**: 
  - `zone_id` → `zones(id)` (ON DELETE CASCADE)
  - `device_id` → `devices(id)`
  - `created_by` → `users(id)`
- **索引**: `zone_id`, `device_id`, `modbus_config` (GIN), `status`, `created_at`

#### 3.6 系統設定

##### `system_settings` 表
- **用途**: 系統設定儲存
- **主要欄位**:
  - `id`: 主鍵
  - `key`: 設定鍵（唯一）
  - `value`: 設定值（TEXT）
  - `description`: 描述
  - `created_at`, `updated_at`: 時間戳記
- **唯一約束**: `key`
- **索引**: `key`

### 4. 輔助功能

#### 4.1 自動更新觸發器

**函數**: `update_updated_at_column()`
- **用途**: 自動更新 `updated_at` 欄位
- **觸發時機**: 在 UPDATE 操作前觸發
- **應用表**: 所有包含 `updated_at` 欄位的表

**輔助函數**: `createUpdatedAtTrigger(pool, tableName)`
- **用途**: 為指定表建立 `updated_at` 自動更新觸發器
- **使用方式**: 
  ```javascript
  await createUpdatedAtTrigger(targetPool, "table_name");
  ```

#### 4.2 預設資料

系統會自動插入以下預設資料：

**設備類型** (`device_types`):
- 攝影機 (camera)
- 感測器 (sensor)
- 控制器 (controller)
- 平板 (tablet)
- 網路裝置 (network)

### 5. 資料庫遷移與相容性

腳本包含多處相容性處理，確保在現有資料庫上安全執行：

1. **ENUM 值擴充**: 自動添加 `'people_counting'` 到 `alert_source` ENUM（如果不存在）
2. **欄位添加**: 
   - `device_models.port` 欄位（如果不存在）
   - `zones.image_url` 欄位（如果不存在）
   - `locations.description` 欄位（如果不存在）
3. **約束添加**: `locations` 表的 `unique_zone_location_name` 約束（如果不存在）
4. **表建立**: 所有表使用 `CREATE TABLE IF NOT EXISTS`，避免重複建立

## 資料庫架構設計原則

### 1. 統一地點管理
- 使用 `zones` → `locations` → `location_systems` 三層架構
- 物理地點與系統配置分離
- 支援多系統類型（environment, lighting, people_counting）

### 2. 統一警報系統
- 所有系統來源的警報統一管理在 `alerts` 表
- 使用 `source` + `source_id` 標識來源實體
- 支援按天限制邏輯（應用層實現）

### 3. 統一設備資料記錄
- 所有設備數值統一記錄在 `device_data_logs` 表
- 使用 JSONB 儲存靈活的數值結構
- 支援 Modbus 暫存器類型

### 4. 外鍵約束策略
- **ON DELETE CASCADE**: 子表資料隨父表刪除（如 `locations` → `zones`）
- **ON DELETE RESTRICT**: 防止刪除有引用的資料（如 `devices` → `device_models`）
- **ON DELETE SET NULL**: 刪除時設為 NULL（如 `devices.created_by` → `users`）

## 索引策略

### 1. 主鍵索引
- 所有表都有 `SERIAL` 或 `BIGSERIAL` 主鍵，自動建立主鍵索引

### 2. 外鍵索引
- 為所有外鍵欄位建立索引，優化 JOIN 查詢

### 3. 查詢優化索引
- **複合索引**: 針對常見查詢模式建立複合索引
- **部分索引**: 使用 `WHERE` 條件建立部分索引（如 `alerts` 表的活躍警報索引）
- **GIN 索引**: 為 JSONB 欄位建立 GIN 索引，支援高效 JSON 查詢

### 4. 唯一索引
- 為需要唯一性的欄位或欄位組合建立唯一索引

## 錯誤處理

腳本包含完整的錯誤處理機制：

1. **連接錯誤**: 捕獲資料庫連接失敗
2. **表建立錯誤**: 使用 `IF NOT EXISTS` 避免重複建立
3. **ENUM 錯誤**: 使用 `DO $$ BEGIN ... EXCEPTION` 處理重複建立
4. **欄位添加錯誤**: 檢查欄位是否存在後再添加
5. **約束添加錯誤**: 檢查約束是否存在後再添加

## 注意事項

1. **執行順序**: 必須先執行 `npm run postgres:download` 建立並啟動 PostgreSQL，然後才能執行 `npm run db:init`
2. **資料庫連接**: 確保 `.env` 中的資料庫配置正確（`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`）
3. **權限要求**: 執行腳本的使用者必須有建立資料庫、表、索引等權限
4. **資料備份**: 在生產環境執行前，建議先備份現有資料
5. **遷移相容性**: 腳本設計為可重複執行（idempotent），但建議在測試環境先驗證

## 相關文件

- [資料庫文檔](./DATABASE_DOCUMENTATION.md)
- [後端架構分析](./BACKEND_ARCHITECTURE_ANALYSIS.md)
- [警報系統實現指南](./ALERT_IMPLEMENTATION_GUIDE.md)
