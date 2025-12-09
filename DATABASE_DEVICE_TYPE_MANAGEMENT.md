# 設備類型資料庫管理指南

## 概述

設備類型管理功能已從 API 中移除，現在設備類型資料需要直接透過資料庫進行管理。設備類型僅供讀取，用於設備型號管理時選擇類型。

## 資料庫結構

設備類型表：`modbus_device_types`

```sql
CREATE TABLE IF NOT EXISTS `modbus_device_types` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50) NOT NULL UNIQUE,
  `code` VARCHAR(20) NOT NULL UNIQUE,
  `description` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## 預設資料

資料庫初始化腳本會自動插入以下預設設備類型：

- **DI/DO** (code: `DI_DO`) - 數位輸入/輸出設備
- **Sensor** (code: `SENSOR`) - 感測器設備

## 如何修改設備類型資料

### 方法 1：使用 MySQL 命令列

```bash
# 連接到資料庫
mysql -u <username> -p <database_name>
```

然後執行 SQL 語句：

```sql
-- 查看所有設備類型
SELECT * FROM modbus_device_types;

-- 新增設備類型
INSERT INTO modbus_device_types (name, code, description) 
VALUES ('新類型名稱', 'NEW_TYPE_CODE', '類型描述');

-- 更新設備類型
UPDATE modbus_device_types 
SET name = '更新後的名稱', description = '更新後的描述' 
WHERE id = 1;

-- 刪除設備類型（注意：如果有設備型號使用此類型，會因為外鍵約束而失敗）
DELETE FROM modbus_device_types WHERE id = 1;
```

### 方法 2：使用資料庫管理工具

使用 MySQL Workbench、phpMyAdmin、DBeaver 等工具：

1. 連接到資料庫
2. 找到 `modbus_device_types` 表
3. 直接編輯、新增或刪除記錄

### 方法 3：修改初始化腳本（適用於新環境）

編輯 `src/database/initSchema.js` 文件，修改預設資料部分：

```javascript
// 插入預設的設備類型資料
const deviceTypes = [
	{ name: "DI/DO", code: "DI_DO", description: "數位輸入/輸出設備" },
	{ name: "Sensor", code: "SENSOR", description: "感測器設備" },
	// 添加新的設備類型
	{ name: "新類型", code: "NEW_TYPE", description: "新類型描述" }
];
```

然後重新執行初始化腳本：

```bash
npm run db:init
```

**注意**：使用 `INSERT IGNORE` 語句，所以不會覆蓋現有資料。

## 重要注意事項

### 1. 外鍵約束

設備型號表 (`modbus_device_models`) 有外鍵約束指向設備類型：

```sql
FOREIGN KEY (`type_id`) REFERENCES `modbus_device_types`(`id`) ON DELETE RESTRICT
```

這意味著：
- **無法刪除**正在被設備型號使用的設備類型
- 刪除前需要先刪除或修改所有使用該類型的設備型號

### 2. 檢查使用情況

在刪除設備類型前，先檢查是否有設備型號使用：

```sql
-- 檢查設備類型是否被使用
SELECT m.*, t.name as type_name 
FROM modbus_device_models m
JOIN modbus_device_types t ON m.type_id = t.id
WHERE t.id = 1;  -- 替換為要檢查的類型 ID
```

### 3. 代碼唯一性

`code` 欄位必須唯一，新增時需確保不重複：

```sql
-- 檢查代碼是否已存在
SELECT * FROM modbus_device_types WHERE code = 'NEW_CODE';
```

## 常用 SQL 操作範例

### 新增設備類型

```sql
INSERT INTO modbus_device_types (name, code, description) 
VALUES ('執行器', 'ACTUATOR', '控制執行器設備');
```

### 更新設備類型

```sql
UPDATE modbus_device_types 
SET 
  name = '更新後的名稱',
  description = '更新後的描述'
WHERE id = 1;
```

### 刪除設備類型（需先確認無使用）

```sql
-- 步驟 1：檢查是否有設備型號使用
SELECT COUNT(*) as usage_count 
FROM modbus_device_models 
WHERE type_id = 1;

-- 步驟 2：如果 usage_count = 0，可以安全刪除
DELETE FROM modbus_device_types WHERE id = 1;
```

### 查詢所有設備類型及其使用情況

```sql
SELECT 
  t.id,
  t.name,
  t.code,
  t.description,
  COUNT(m.id) as model_count
FROM modbus_device_types t
LEFT JOIN modbus_device_models m ON t.id = m.type_id
GROUP BY t.id, t.name, t.code, t.description
ORDER BY t.id;
```

## 資料庫備份建議

在修改設備類型資料前，建議先備份：

```bash
# 備份整個資料庫
mysqldump -u <username> -p <database_name> > backup_$(date +%Y%m%d_%H%M%S).sql

# 或只備份設備類型表
mysqldump -u <username> -p <database_name> modbus_device_types > device_types_backup.sql
```

## 恢復備份

```bash
# 恢復整個資料庫
mysql -u <username> -p <database_name> < backup_file.sql

# 或只恢復設備類型表
mysql -u <username> -p <database_name> < device_types_backup.sql
```

## 相關檔案

- 資料庫初始化腳本：`src/database/initSchema.js`
- 設備類型服務（僅讀取）：`src/services/deviceTypeService.js`
- 設備類型路由（僅讀取）：`src/routes/modbusRoutes.js` (GET 路由)

