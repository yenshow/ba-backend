# 後端 API 文檔

## 基礎資訊

- **Base URL**: `http://localhost:4000/api` 或 `http://<server-ip>:4000/api`
- **認證方式**: JWT Token（Bearer Token）
- **Content-Type**: `application/json`

---

## API 路由總覽

### 1. 設備管理 API (`/api/devices`)

#### 設備類型 (Device Types)

| 方法   | 路徑                            | 認證   | 說明                 |
| ------ | ------------------------------- | ------ | -------------------- |
| GET    | `/api/devices/types`            | 公開   | 取得所有設備類型     |
| GET    | `/api/devices/types/code/:code` | 公開   | 根據代碼取得設備類型 |
| GET    | `/api/devices/types/:id`        | 公開   | 取得單一設備類型     |
| POST   | `/api/devices/types`            | 管理員 | 建立設備類型         |
| PUT    | `/api/devices/types/:id`        | 管理員 | 更新設備類型         |
| DELETE | `/api/devices/types/:id`        | 管理員 | 刪除設備類型         |

#### 設備型號 (Device Models)

| 方法   | 路徑                      | 認證   | 說明                                                 |
| ------ | ------------------------- | ------ | ---------------------------------------------------- |
| GET    | `/api/devices/models`     | 公開   | 取得設備型號列表（支援 `type_id`、`type_code` 篩選） |
| GET    | `/api/devices/models/:id` | 公開   | 取得單一設備型號                                     |
| POST   | `/api/devices/models`     | 管理員 | 建立設備型號                                         |
| PUT    | `/api/devices/models/:id` | 管理員 | 更新設備型號                                         |
| DELETE | `/api/devices/models/:id` | 管理員 | 刪除設備型號                                         |

#### 設備 (Devices)

| 方法   | 路徑               | 認證   | 說明                                                       |
| ------ | ------------------ | ------ | ---------------------------------------------------------- |
| GET    | `/api/devices`     | 公開   | 取得設備列表（支援 `type_id`、`type_code`、`status` 篩選） |
| GET    | `/api/devices/:id` | 公開   | 取得單一設備                                               |
| POST   | `/api/devices`     | 管理員 | 創建設備                                                   |
| PUT    | `/api/devices/:id` | 管理員 | 更新設備                                                   |
| DELETE | `/api/devices/:id` | 管理員 | 刪除設備                                                   |

### 2. Modbus 數據讀取 API (`/api/modbus`)

| 方法 | 路徑                            | 認證 | 說明                 |
| ---- | ------------------------------- | ---- | -------------------- |
| GET  | `/api/modbus/health`            | 公開 | 檢查 Modbus 連接狀態 |
| GET  | `/api/modbus/holding-registers` | 公開 | 讀取保持寄存器       |
| GET  | `/api/modbus/input-registers`   | 公開 | 讀取輸入寄存器       |
| GET  | `/api/modbus/coils`             | 公開 | 讀取線圈（DO）       |
| GET  | `/api/modbus/discrete-inputs`   | 公開 | 讀取離散輸入（DI）   |
| PUT  | `/api/modbus/coils`             | 公開 | 寫入線圈（DO）       |

**查詢參數（所有 Modbus 讀取路由）：**

- `host` (必填) - 設備 IP 位址
- `port` (必填) - 端口號
- `unitId` (必填) - Unit ID
- `address` (可選，預設 0) - 起始地址
- `length` (可選，預設 10) - 讀取長度

### 3. 用戶管理 API (`/api/users`)

| 方法   | 路徑                      | 認證        | 說明             |
| ------ | ------------------------- | ----------- | ---------------- |
| POST   | `/api/users/register`     | 公開        | 註冊新用戶       |
| POST   | `/api/users/login`        | 公開        | 用戶登入         |
| GET    | `/api/users/me`           | 用戶        | 取得當前用戶資訊 |
| GET    | `/api/users`              | 管理員      | 取得用戶列表     |
| GET    | `/api/users/:id`          | 管理員      | 取得單一用戶     |
| PUT    | `/api/users/:id`          | 用戶/管理員 | 更新用戶資訊     |
| PUT    | `/api/users/:id/password` | 用戶/管理員 | 更新密碼         |
| DELETE | `/api/users/:id`          | 管理員      | 刪除用戶         |

### 4. RTSP 串流 API (`/api/rtsp`)

| 方法 | 路徑                         | 認證 | 說明                  |
| ---- | ---------------------------- | ---- | --------------------- |
| POST | `/api/rtsp/start`            | 公開 | 啟動 RTSP 轉 HLS 串流 |
| POST | `/api/rtsp/stop/:streamId`   | 公開 | 停止串流              |
| GET  | `/api/rtsp/status`           | 公開 | 取得所有串流狀態      |
| GET  | `/api/rtsp/status/:streamId` | 公開 | 取得單一串流狀態      |

### 5. 照明系統 API (`/api/lighting`)

#### 分類點 (Categories)

| 方法   | 路徑                                       | 認證     | 說明                                   |
| ------ | ------------------------------------------ | -------- | -------------------------------------- |
| GET    | `/api/lighting/categories`                 | 公開     | 取得分類點列表（支援 `floor_id` 篩選） |
| GET    | `/api/lighting/categories/:id`             | 公開     | 取得單一分類點                         |
| POST   | `/api/lighting/categories`                 | 需要認證 | 建立分類點                             |
| PUT    | `/api/lighting/categories/:id`             | 需要認證 | 更新分類點                             |
| DELETE | `/api/lighting/categories/:id`             | 需要認證 | 刪除分類點                             |
| PUT    | `/api/lighting/categories/batch/positions` | 需要認證 | 批次更新分類點位置（拖曳用）           |

**查詢參數（GET `/api/lighting/categories`）：**

- `floor_id` (可選) - 樓層 ID（如：`1F`、`2F`）

**請求體範例（POST `/api/lighting/categories`）：**

```json
{
  "name": "主燈開關",
  "floorId": "1F",
  "location": {
    "x": 50,
    "y": 50
  },
  "description": "控制展廳主燈",
  "deviceId": 1,
  "modbus": {
    "deviceId": 1,
    "points": [
      {
        "id": "point-1234567890-0.123",
        "address": 10,
        "type": "DO",
        "note": "控制主燈開關"
      }
    ]
  },
  "roomIds": [],
  "status": "active"
}
```

**注意：** 支援前端格式（`floorId`、`location`、`deviceId`、`modbus`、`roomIds`）和後端格式（`floor_id`、`location_x`、`location_y`、`device_id`、`modbus_config`、`room_ids`）

**回應範例（GET `/api/lighting/categories`）：**

```json
{
  "categories": [
    {
      "id": "1",
      "name": "主燈開關",
      "floorId": "1F",
      "location": {
        "x": 50,
        "y": 50
      },
      "description": "控制展廳主燈",
      "roomIds": [],
      "modbus": {
        "deviceId": 1,
        "points": [
          {
            "id": "point-1234567890-0.123",
            "address": 10,
            "type": "DO",
            "note": "控制主燈開關"
          }
        ]
      },
      "status": "active",
      "device_id": 1,
      "device_name": "展廳燈控",
      "device_status": "active",
      "created_at": "2025-01-01T10:00:00.000Z",
      "updated_at": "2025-01-01T10:00:00.000Z"
    }
  ]
}
```

**批次更新位置（PUT `/api/lighting/categories/batch/positions`）：**

```json
{
  "updates": [
    {
      "id": 1,
      "location_x": 60,
      "location_y": 70
    },
    {
      "id": 2,
      "location_x": 40,
      "location_y": 30
    }
  ]
}
```

### 6. 已棄用的路由 (`/api/modbus`)

以下路由已移至 `/api/devices`，保留僅為向後兼容：

| 方法   | 路徑                            | 狀態   | 替代路由                  |
| ------ | ------------------------------- | ------ | ------------------------- |
| GET    | `/api/modbus/device-types`      | 已棄用 | `/api/devices/types`      |
| GET    | `/api/modbus/device-types/:id`  | 已棄用 | `/api/devices/types/:id`  |
| GET    | `/api/modbus/device-models`     | 已棄用 | `/api/devices/models`     |
| GET    | `/api/modbus/device-models/:id` | 已棄用 | `/api/devices/models/:id` |
| POST   | `/api/modbus/device-models`     | 已棄用 | `/api/devices/models`     |
| PUT    | `/api/modbus/device-models/:id` | 已棄用 | `/api/devices/models/:id` |
| DELETE | `/api/modbus/device-models/:id` | 已棄用 | `/api/devices/models/:id` |

---

## 詳細 API 說明

### 創建設備

**POST** `/api/devices`

**認證**: 需要管理員權限

**請求體範例（controller 類型）：**

```json
{
  "name": "展廳燈控",
  "type_id": 40,
  "model_id": 3,
  "description": "展廳燈光控制器",
  "status": "active",
  "config": {
    "type": "controller",
    "host": "192.168.2.205",
    "port": 502,
    "unitId": 1
  }
}
```

**注意：**

- `model_id` 是必填的
- `config.port` 可選（會從 `device_models.port` 繼承）
- `config.unitId` 可選（未提供時會自動生成）

**回應範例：**

```json
{
  "device": {
    "id": 1,
    "name": "展廳燈控",
    "type_id": 40,
    "model_id": 3,
    "type_name": "控制器",
    "type_code": "controller",
    "model_name": "ZC160",
    "status": "active",
    "config": {
      "type": "controller",
      "host": "192.168.2.205",
      "port": 502,
      "unitId": 1
    },
    "created_at": "2025-12-12T11:27:43.994Z"
  }
}
```

### 更新設備

**PUT** `/api/devices/:id`

**認證**: 需要管理員權限

**請求體範例：**

```json
{
  "name": "展廳燈控（更新）",
  "status": "inactive",
  "config": {
    "type": "controller",
    "host": "192.168.2.206",
    "port": 502
  }
}
```

**注意：**

- 可以只更新部分欄位
- `config.unitId` 如果未提供且 `host` 或 `port` 有變更，會自動重新生成

### 取得設備列表

**GET** `/api/devices`

**查詢參數：**

- `type_id` (可選) - 設備類型 ID
- `type_code` (可選) - 設備類型代碼（如 `controller`、`camera`）
- `status` (可選) - 狀態篩選（`active`、`inactive`、`error`）
- `limit` (可選，預設 20) - 每頁數量
- `offset` (可選，預設 0) - 偏移量
- `orderBy` (可選，預設 `created_at`) - 排序欄位
- `order` (可選，預設 `desc`) - 排序方向（`asc`、`desc`）

**回應範例：**

```json
{
  "devices": [
    {
      "id": 1,
      "name": "展廳燈控",
      "type_id": 40,
      "model_id": 3,
      "type_name": "控制器",
      "type_code": "controller",
      "model_name": "ZC160",
      "status": "active",
      "config": {
        "type": "controller",
        "host": "192.168.2.205",
        "port": 502,
        "unitId": 1
      }
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### 讀取 Modbus 數據

**GET** `/api/modbus/holding-registers?host=192.168.2.205&port=502&unitId=1&address=0&length=10`

**查詢參數：**

- `host` (必填) - 設備 IP
- `port` (必填) - 端口
- `unitId` (必填) - Unit ID
- `address` (可選，預設 0) - 起始地址
- `length` (可選，預設 10) - 讀取長度（1-125）

**回應範例：**

```json
{
  "address": 0,
  "length": 10,
  "data": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "device": {
    "host": "192.168.2.205",
    "port": 502,
    "unitId": 1
  }
}
```

---

## 錯誤處理

所有 API 錯誤都會返回以下格式：

```json
{
  "error": true,
  "message": "錯誤訊息",
  "details": "詳細錯誤訊息",
  "timestamp": "2025-12-12T11:27:43.994Z"
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
- `503` - 服務不可用（如 Modbus 連接失敗）

---

## 認證

### 登入取得 Token

**POST** `/api/users/login`

```json
{
  "username": "admin",
  "password": "password"
}
```

**回應：**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin"
  }
}
```

### 使用 Token

在請求頭中添加：

```
Authorization: Bearer <token>
```

---

## 快取控制

所有 GET 請求都設置了以下快取控制標頭：

```
Cache-Control: no-cache, must-revalidate
Pragma: no-cache
Expires: 0
```

這確保前端總是取得最新的資料。

---

## 注意事項

1. **設備創建**：

   - `model_id` 是必填的
   - `config.unitId` 如果未提供，會自動生成（從 1 開始，查找未使用的 ID）

2. **設備更新**：

   - 可以只更新部分欄位
   - `config` 更新時會驗證類型匹配

3. **Modbus 讀取**：

   - 所有 Modbus 讀取路由都需要在查詢參數中提供 `host`、`port`、`unitId`
   - 這些參數可以從設備的 `config` 中取得

4. **已棄用路由**：
   - `/api/modbus/device-*` 路由已棄用，建議前端遷移到 `/api/devices/*`
