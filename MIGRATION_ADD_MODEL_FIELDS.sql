-- 資料庫遷移腳本：為 modbus_device_models 表添加 type_id 和 port 欄位
-- 執行此腳本以修復 "Unknown column 'm.type_id' in 'field list'" 錯誤

-- 步驟 1：檢查欄位是否已存在（可選，用於確認）
-- SELECT COLUMN_NAME 
-- FROM INFORMATION_SCHEMA.COLUMNS 
-- WHERE TABLE_SCHEMA = DATABASE()
-- AND TABLE_NAME = 'modbus_device_models' 
-- AND COLUMN_NAME IN ('type_id', 'port');

-- 步驟 2：添加 type_id 欄位（如果不存在）
-- 注意：如果欄位已存在，此語句會報錯，可以忽略或先檢查
ALTER TABLE `modbus_device_models`
ADD COLUMN `type_id` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '設備類型 ID' AFTER `name`;

-- 步驟 3：添加 port 欄位（如果不存在）
ALTER TABLE `modbus_device_models`
ADD COLUMN `port` INT UNSIGNED NOT NULL DEFAULT 502 COMMENT 'Modbus 端口' AFTER `type_id`;

-- 步驟 4：添加索引（如果不存在）
ALTER TABLE `modbus_device_models`
ADD INDEX `idx_type_id` (`type_id`);

ALTER TABLE `modbus_device_models`
ADD INDEX `idx_port` (`port`);

-- 步驟 5：添加外鍵約束（如果不存在）
-- 注意：確保 modbus_device_types 表中有至少一個設備類型（id=1）
ALTER TABLE `modbus_device_models`
ADD CONSTRAINT `fk_model_type` FOREIGN KEY (`type_id`) REFERENCES `modbus_device_types`(`id`) ON DELETE RESTRICT;

-- 驗證：檢查欄位是否已成功添加
-- SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
-- FROM INFORMATION_SCHEMA.COLUMNS 
-- WHERE TABLE_SCHEMA = DATABASE()
-- AND TABLE_NAME = 'modbus_device_models'
-- AND COLUMN_NAME IN ('type_id', 'port');

