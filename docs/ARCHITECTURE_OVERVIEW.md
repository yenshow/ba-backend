# 後端架構總覽

## 專案結構

```
ba-backend/
├── src/
│   ├── config.js                    # 配置檔案
│   ├── server.js                    # Express 伺服器主程式
│   ├── database/
│   │   ├── db.js                    # 資料庫連線池與查詢封裝
│   │   └── initSchema.js            # 資料庫 Schema 初始化
│   ├── middleware/
│   │   └── authMiddleware.js        # JWT 認證中間件
│   ├── routes/
│   │   ├── deviceRoutes.js          # 設備管理 API 路由
│   │   ├── lightingRoutes.js        # 照明系統 API 路由 ⭐
│   │   ├── modbusRoutes.js          # Modbus 通訊 API 路由
│   │   ├── rtspRoutes.js            # RTSP 串流 API 路由
│   │   └── userRoutes.js            # 用戶管理 API 路由
│   ├── services/
│   │   ├── deviceService.js         # 設備服務層
│   │   ├── deviceTypeService.js     # 設備類型服務層
│   │   ├── deviceModelService.js    # 設備型號服務層
│   │   ├── lightingService.js       # 照明系統服務層 ⭐
│   │   ├── modbusClient.js          # Modbus 客戶端
│   │   ├── rtspStreamService.js     # RTSP 串流服務
│   │   └── userService.js           # 用戶服務層
│   └── utils/
│       └── deviceHelpers.js         # 設備相關工具函數
├── scripts/
│   ├── createLightingCategoriesTable.js  # 照明系統遷移腳本 ⭐
│   └── ... (其他遷移腳本)
└── package.json
```

---

## 資料庫架構

### 核心表（所有系統共用）

#### 1. users（用戶表）
- 用戶帳號、密碼、角色、狀態

#### 2. device_types（設備類型表）
- 設備類型定義（camera, controller, sensor, tablet, network）

#### 3. device_models（設備型號表）
- 設備型號定義，包含預設端口

#### 4. devices（設備表）
- 實際設備實例
- `config` JSONB 欄位統一儲存連接資訊

### 系統特定表

#### 5. lighting_categories（照明系統分類點表）⭐

| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | SERIAL | 主鍵 |
| `name` | VARCHAR(100) | 分類點名稱 |
| `floor_id` | VARCHAR(50) | 樓層 ID |
| `location_x` | DECIMAL(5,2) | 位置 X（百分比） |
| `location_y` | DECIMAL(5,2) | 位置 Y（百分比） |
| `description` | TEXT | 描述 |
| `device_id` | INTEGER | 關聯設備 ID（FK → devices.id） |
| `modbus_config` | JSONB | Modbus 配置（包含 deviceId 和 points） |
| `room_ids` | INTEGER[] | 房間 ID 列表 |
| `status` | VARCHAR(50) | 狀態 |
| `created_by` | INTEGER | 建立者 ID（FK → users.id） |
| `created_at` | TIMESTAMP | 建立時間 |
| `updated_at` | TIMESTAMP | 更新時間 |

**索引：**
- `idx_lighting_categories_floor_id` - 樓層索引
- `idx_lighting_categories_device_id` - 設備索引
- `idx_lighting_categories_modbus_config` - JSONB GIN 索引
- `idx_lighting_categories_status` - 狀態索引
- `idx_lighting_categories_created_at` - 建立時間索引

#### 6. device_data_logs（設備資料記錄表）
- 設備資料歷史記錄

#### 7. device_alerts（設備警示表）
- 設備警示與通知

---

## API 路由架構

### 路由註冊（server.js）

```javascript
app.use("/api/modbus", modbusRoutes);      // Modbus 通訊
app.use("/api/users", userRoutes);         // 用戶管理
app.use("/api/rtsp", rtspRoutes);         // RTSP 串流
app.use("/api/devices", deviceRoutes);    // 設備管理
app.use("/api/lighting", lightingRoutes); // 照明系統 ⭐
```

### 照明系統 API（/api/lighting）

| 方法 | 路徑 | 認證 | 服務函數 |
|------|------|------|----------|
| GET | `/categories` | 公開 | `getCategories()` |
| GET | `/categories/:id` | 公開 | `getCategoryById()` |
| POST | `/categories` | 需要 | `createCategory()` |
| PUT | `/categories/:id` | 需要 | `updateCategory()` |
| DELETE | `/categories/:id` | 需要 | `deleteCategory()` |
| PUT | `/categories/batch/positions` | 需要 | `updateBatchPositions()` |

---

## 服務層架構

### lightingService.js 功能

1. **getCategories(filters)**
   - 取得分類點列表
   - 支援按 `floor_id` 篩選
   - 自動轉換為前端格式（camelCase）

2. **getCategoryById(id)**
   - 取得單一分類點
   - 包含關聯設備資訊

3. **createCategory(categoryData, userId)**
   - 建立分類點
   - 支援前端格式和後端格式
   - 完整資料驗證

4. **updateCategory(id, categoryData, userId)**
   - 更新分類點
   - 支援部分更新
   - 支援前端格式和後端格式

5. **deleteCategory(id)**
   - 刪除分類點
   - 檢查存在性

6. **updateBatchPositions(updates)**
   - 批次更新位置（拖曳用）
   - 使用事務確保一致性

### 格式轉換機制

**輸入格式支援：**
- 前端格式：`floorId`, `location`, `deviceId`, `modbus`, `roomIds`
- 後端格式：`floor_id`, `location_x`, `location_y`, `device_id`, `modbus_config`, `room_ids`

**輸出格式：**
- 統一轉換為前端格式（camelCase）
- `id` 轉換為字串
- `location` 轉換為物件 `{ x, y }`

---

## 資料庫連線管理

### db.js 功能

1. **連線池管理**
   - 使用 PostgreSQL `pg` 連線池
   - 自動參數轉換（`?` → `$1, $2, ...`）

2. **查詢封裝**
   - `query(sql, params)` - 執行查詢
   - `transaction(callback)` - 執行事務

3. **錯誤處理**
   - 統一的錯誤處理機制

---

## 認證與授權

### authMiddleware.js

- `authenticate` - JWT Token 驗證
- `requireAdmin` - 管理員權限檢查

### 照明系統 API 認證

- **讀取操作**（GET）：公開，無需認證
- **寫入操作**（POST/PUT/DELETE）：需要認證（`authenticate`）

---

## 錯誤處理

### 統一錯誤格式

```json
{
  "error": true,
  "message": "錯誤訊息",
  "details": "詳細錯誤訊息",
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

### HTTP 狀態碼

- `200` - 成功
- `201` - 創建成功
- `400` - 請求參數錯誤
- `401` - 未認證
- `403` - 權限不足
- `404` - 資源不存在
- `500` - 伺服器錯誤
- `503` - 服務不可用

---

## 資料流程

### 照明系統資料流程

```
前端請求
    ↓
Express Router (lightingRoutes.js)
    ↓
Service Layer (lightingService.js)
    ├─ 格式轉換（前端格式 → 後端格式）
    ├─ 資料驗證
    └─ 錯誤處理
    ↓
Database Layer (db.js)
    ├─ 參數轉換（? → $1, $2, ...）
    └─ 執行 SQL
    ↓
PostgreSQL Database
    ↓
回應資料
    ├─ 格式轉換（後端格式 → 前端格式）
    └─ JSON 回應
```

---

## 擴展性設計

### 多系統架構模式

每個系統遵循相同的設計模式：

1. **資料表命名**：`{system_name}_{entity_name}`
   - 例如：`lighting_categories`、`hvac_zones`、`fire_alarms`

2. **API 路由**：`/api/{system-name}/{entity-name}`
   - 例如：`/api/lighting/categories`、`/api/hvac/zones`

3. **服務層**：`{systemName}Service.js`
   - 例如：`lightingService.js`、`hvacService.js`

4. **核心欄位**：所有系統表都包含
   - `id`, `name`, `status`, `created_at`, `updated_at`
   - 可選：`device_id`, `floor_id`, `location_x`, `location_y`

### 未來擴展範例

**空調系統（HVAC）：**
```sql
CREATE TABLE hvac_zones (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  floor_id VARCHAR(50) NOT NULL,
  device_id INTEGER REFERENCES devices(id),
  hvac_config JSONB,  -- 溫度設定、風速等
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**消防系統（Fire）：**
```sql
CREATE TABLE fire_alarms (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  floor_id VARCHAR(50) NOT NULL,
  device_id INTEGER REFERENCES devices(id),
  alarm_config JSONB,  -- 警報設定、感應器類型等
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 關鍵設計決策

### 1. 統一配置存儲

所有設備連接資訊統一儲存在 `devices.config` JSONB 欄位中，不再使用獨立的 `modbus_*` 欄位。

**優點：**
- 結構清晰
- 易於擴展
- 支援不同設備類型

### 2. 設備集中管理

照明系統透過 `device_id` 引用設備，而不是直接儲存連接資訊。

**優點：**
- 設備資訊集中管理
- 設備變更時自動生效
- 避免資料重複

### 3. 格式轉換層

服務層自動處理前端格式（camelCase）和後端格式（snake_case）的轉換。

**優點：**
- 前端使用習慣的格式
- 後端使用資料庫標準格式
- 自動轉換，無需手動處理

### 4. 獨立系統表

每個系統建立獨立的資料表，而不是使用統一的 `system_entities` 表。

**優點：**
- 資料結構清晰
- 查詢效能佳
- 易於維護和擴展

---

## 測試建議

### 1. 資料庫測試

```bash
# 初始化資料庫
npm run db:init

# 測試遷移腳本
npm run db:migrate:lighting-categories

# 測試連線
npm run db:test
```

### 2. API 測試

使用 Postman 或 curl 測試：

```bash
# 取得分類點列表
curl http://localhost:4000/api/lighting/categories

# 取得特定樓層的分類點
curl http://localhost:4000/api/lighting/categories?floor_id=1F

# 建立分類點（需要認證）
curl -X POST http://localhost:4000/api/lighting/categories \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "主燈開關",
    "floorId": "1F",
    "location": { "x": 50, "y": 50 },
    "deviceId": 1,
    "modbus": {
      "deviceId": 1,
      "points": [{
        "address": 10,
        "type": "DO",
        "note": "控制主燈開關"
      }]
    }
  }'
```

---

## 總結

### 已完成

- ✅ 資料庫結構（lighting_categories 表）
- ✅ API 路由（完整的 CRUD）
- ✅ 服務層（格式轉換、驗證、錯誤處理）
- ✅ 資料庫初始化（已修正 deviceTypes 問題）
- ✅ API 文檔

### 待完成

- ⏳ API 測試
- ⏳ 前端整合（建立 useLightingApi composable）
- ⏳ 資料遷移（從 localStorage 遷移到資料庫）

### 架構特點

1. **模組化設計**：每個系統獨立管理
2. **統一模式**：所有系統遵循相同的設計模式
3. **格式轉換**：自動處理前後端格式差異
4. **擴展性佳**：易於新增新系統

---

**最後更新：** 2025-01-XX  
**狀態：** 後端核心功能已完成，可開始測試和前端整合

