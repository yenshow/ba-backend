-- 通用設備管理系統資料庫遷移腳本

-- 1. 確保設備類型表存在並包含所需的 5 種類型
-- 注意：如果已有 modbus_device_types 表，可以選擇：
--   a) 使用現有表（向後兼容）
--   b) 創建新的 device_types 表並遷移資料

-- 選項 A: 創建新的 device_types 表（推薦）
CREATE TABLE IF NOT EXISTS device_types (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL COMMENT '設備類型名稱',
    code VARCHAR(50) UNIQUE NOT NULL COMMENT '設備類型代碼',
    description TEXT COMMENT '設備類型描述',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 插入 5 種設備類型
INSERT INTO device_types (name, code, description) VALUES
('影像設備', 'camera', '監控攝影機、影像擷取設備'),
('控制器', 'controller', 'Modbus 控制器、DDC 控制器'),
('感測器', 'sensor', '各種環境感測器'),
('平板', 'tablet', '平板電腦設備'),
('網路裝置', 'network', '路由器、交換器、無線基地台等網路設備')
ON DUPLICATE KEY UPDATE name=name;

-- 2. 創建設備型號表（如果不存在）
-- 注意：如果已有 modbus_device_models 表，可以選擇：
--   a) 使用現有表（向後兼容，但需要添加 config 欄位）
--   b) 創建新的 device_models 表並遷移資料

-- 選項 A: 創建新的 device_models 表（推薦）
CREATE TABLE IF NOT EXISTS device_models (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    type_id INT NOT NULL,
    description TEXT,
    config JSON COMMENT '可選的型號預設配置',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (type_id) REFERENCES device_types(id)
);

-- 如果 modbus_device_models 表存在，可以遷移資料
-- 注意：需要先確認 device_types 表中有對應的類型
/*
INSERT INTO device_models (name, type_id, description, created_at, updated_at)
SELECT 
    m.name,
    m.type_id,
    m.description,
    m.created_at,
    m.updated_at
FROM modbus_device_models m
WHERE NOT EXISTS (
    SELECT 1 FROM device_models WHERE device_models.id = m.id
);
*/

-- 3. 創建設備表（如果不存在）
-- 注意：如果已有 devices 表，需要檢查是否有 config 欄位

-- 檢查 devices 表是否存在 config 欄位
-- SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'config';

-- 如果 devices 表存在但沒有 config 欄位，添加它
-- ALTER TABLE devices ADD COLUMN config JSON AFTER status;

-- 如果 devices 表不存在，創建表
CREATE TABLE IF NOT EXISTS devices (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    type_id INT NOT NULL,
    model_id INT,
    description TEXT,
    status ENUM('active', 'inactive', 'error') DEFAULT 'inactive',
    config JSON NOT NULL COMMENT '設備配置（根據類型不同）',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by INT COMMENT '建立者用戶 ID',
    FOREIGN KEY (type_id) REFERENCES device_types(id),
    FOREIGN KEY (model_id) REFERENCES device_models(id)
);

-- 4. 如果已有舊的 devices 表（包含 modbus_host, modbus_port 等欄位），遷移資料
-- 注意：請先備份資料庫！

-- 檢查是否有舊的設備資料需要遷移
-- SELECT COUNT(*) FROM devices WHERE config IS NULL OR config = '{}';

-- 如果 devices 表中有舊的 Modbus 設備資料，可以遷移
-- 假設 controller 類型 ID 為 2（請根據實際情況調整）
/*
UPDATE devices 
SET config = JSON_OBJECT(
    'type', 'controller',
    'host', COALESCE(modbus_host, ''),
    'port', COALESCE(modbus_port, 502),
    'unitId', COALESCE(modbus_unit_id, 1)
)
WHERE (config IS NULL OR config = '{}') 
  AND modbus_host IS NOT NULL 
  AND modbus_port IS NOT NULL 
  AND modbus_unit_id IS NOT NULL;
*/

-- 5. 添加索引以提升查詢效能
CREATE INDEX IF NOT EXISTS idx_devices_type_id ON devices(type_id);
CREATE INDEX IF NOT EXISTS idx_devices_model_id ON devices(model_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_device_models_type_id ON device_models(type_id);
CREATE INDEX IF NOT EXISTS idx_device_types_code ON device_types(code);

-- 6. 檢查和驗證
-- 檢查設備類型是否正確
SELECT * FROM device_types WHERE code IN ('camera', 'controller', 'sensor', 'tablet', 'network');

-- 檢查表結構
-- DESCRIBE devices;
-- DESCRIBE device_types;
-- DESCRIBE device_models;
