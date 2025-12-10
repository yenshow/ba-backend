# 通用設備管理系統實作指南

## 概述

此文件說明如何在後端專案中實作通用設備管理系統，支援 5 種設備類型：影像設備、控制器、感測器、平板、網路裝置。

## 檔案結構

已創建的檔案：

```
src/
├── routes/
│   └── deviceRoutes.js          # 通用設備路由（新增）
├── services/
│   ├── deviceService.js         # 通用設備服務（新增）
│   ├── deviceTypeService.js     # 設備類型服務（已更新，支援新功能）
│   └── deviceModelService.js    # 設備型號服務（已更新，支援按類型篩選）
└── utils/
    └── deviceHelpers.js         # 設備相關工具函數（新增）
```

## 安裝步驟

### 1. 執行資料庫遷移

執行 `DATABASE_MIGRATION_DEVICES.sql` 腳本：

```bash
mysql -u your_username -p your_database < DATABASE_MIGRATION_DEVICES.sql
```

或使用你的資料庫管理工具執行腳本。

### 2. 確認路由已註冊

檢查 `src/server.js` 中是否已註冊設備路由：

```javascript
const deviceRoutes = require("./routes/deviceRoutes");
app.use("/api/devices", deviceRoutes);
```

### 3. 確認服務檔案存在

確認以下檔案已創建：

- `src/services/deviceService.js`
- `src/services/deviceTypeService.js`（已更新）
- `src/services/deviceModelService.js`（已更新）
- `src/utils/deviceHelpers.js`
- `src/routes/deviceRoutes.js`

## API 端點

### 設備 API (`/api/devices`)

- `GET /api/devices` - 取得設備列表（支援 `type_code`, `type_id`, `status` 篩選）
- `GET /api/devices/:id` - 取得單一設備
- `POST /api/devices` - 創建設備（需要認證+管理員）
- `PUT /api/devices/:id` - 更新設備（需要認證+管理員）
- `DELETE /api/devices/:id` - 刪除設備（需要認證+管理員）

### 設備類型 API (`/api/devices/types`)

- `GET /api/devices/types` - 取得所有設備類型
- `GET /api/devices/types/:id` - 取得單一設備類型
- `GET /api/devices/types/code/:code` - 根據代碼取得設備類型 ⭐
- `POST /api/devices/types` - 創建設備類型（需要認證+管理員）
- `PUT /api/devices/types/:id` - 更新設備類型（需要認證+管理員）
- `DELETE /api/devices/types/:id` - 刪除設備類型（需要認證+管理員）

### 設備型號 API (`/api/devices/models`)

- `GET /api/devices/models` - 取得設備型號列表（支援 `type_code`, `type_id` 篩選）
- `GET /api/devices/models/:id` - 取得單一設備型號
- `POST /api/devices/models` - 創建設備型號（需要認證+管理員）
- `PUT /api/devices/models/:id` - 更新設備型號（需要認證+管理員）
- `DELETE /api/devices/models/:id` - 刪除設備型號（需要認證+管理員）

## 資料庫表結構

### device_types 表

```sql
CREATE TABLE device_types (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### device_models 表

```sql
CREATE TABLE device_models (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    type_id INT NOT NULL,
    description TEXT,
    config JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (type_id) REFERENCES device_types(id)
);
```

### devices 表

```sql
CREATE TABLE devices (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    type_id INT NOT NULL,
    model_id INT,
    description TEXT,
    status ENUM('active', 'inactive', 'error') DEFAULT 'inactive',
    config JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by INT,
    FOREIGN KEY (type_id) REFERENCES device_types(id),
    FOREIGN KEY (model_id) REFERENCES device_models(id)
);
```

## 向後兼容性

### 設備類型服務

`deviceTypeService.js` 已更新為支援向後兼容：

- 優先從 `device_types` 表讀取
- 如果 `device_types` 不存在或為空，從 `modbus_device_types` 讀取

### 設備型號服務

`deviceModelService.js` 已更新為支援向後兼容：

- 優先從 `device_models` 表讀取
- 如果 `device_models` 不存在或為空，從 `modbus_device_models` 讀取
- 支援按 `type_code` 和 `type_id` 篩選

## 配置驗證

所有設備配置會根據 `config.type` 自動驗證：

- **controller**: 需要 `host`, `port`, `unitId`
- **camera**: 需要 `ip_address`
- **sensor**: 根據 `protocol` 驗證（modbus/http/mqtt）
- **tablet**: 需要 `mac_address`
- **network**: 需要 `ip_address`, `device_type`

## 錯誤處理

所有錯誤會透過 Express 錯誤處理中間件統一處理，返回格式：

```json
{
	"error": true,
	"message": "錯誤訊息",
	"details": "詳細錯誤資訊",
	"timestamp": "2024-01-01T00:00:00.000Z"
}
```

## 測試

使用 Postman 或 curl 測試：

```bash
# 取得設備類型列表
curl http://localhost:4000/api/devices/types

# 根據代碼取得設備類型
curl http://localhost:4000/api/devices/types/code/controller

# 取得控制器設備列表
curl http://localhost:4000/api/devices?type_code=controller

# 創建設備（需要認證）
curl -X POST http://localhost:4000/api/devices \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "DDC 控制器 1",
    "type_id": 2,
    "config": {
      "type": "controller",
      "host": "192.168.2.205",
      "port": 502,
      "unitId": 1
    }
  }'
```

## 注意事項

1. **資料庫遷移**: 執行遷移腳本前請先備份資料庫
2. **表名**: 新的通用表使用 `device_types`, `device_models`, `devices`
3. **向後兼容**: 服務會自動嘗試從舊表讀取，但寫入操作會使用新表
4. **配置欄位**: `devices` 表的 `config` 欄位必須是 JSON 格式

## 相關文件

- `BACKEND_CHECKLIST.md` - 詳細的檢查清單（在前端專案中）
- `DATABASE_MIGRATION_DEVICES.sql` - 資料庫遷移腳本
