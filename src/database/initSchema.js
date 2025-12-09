const mysql = require("mysql2/promise");
const config = require("../config");

async function initSchema() {
	let connection;

	try {
		// 先連接到 MySQL（不指定資料庫）以建立資料庫
		connection = await mysql.createConnection({
			host: config.database.host,
			port: config.database.port,
			user: config.database.user,
			password: config.database.password
		});

		console.log("正在建立資料庫...");

		// 建立資料庫（如果不存在）
		await connection.query(`CREATE DATABASE IF NOT EXISTS \`${config.database.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
		console.log(`✅ 資料庫 ${config.database.database} 已準備就緒`);

		// 切換到目標資料庫
		await connection.query(`USE \`${config.database.database}\``);

		// 建立 users 表
		await connection.query(`
      CREATE TABLE IF NOT EXISTS \`users\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`username\` VARCHAR(50) NOT NULL UNIQUE,
        \`email\` VARCHAR(100) NOT NULL UNIQUE,
        \`password_hash\` VARCHAR(255) NOT NULL,
        \`role\` ENUM('admin', 'operator', 'viewer') NOT NULL DEFAULT 'viewer',
        \`status\` ENUM('active', 'inactive', 'suspended') NOT NULL DEFAULT 'active',
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_username\` (\`username\`),
        INDEX \`idx_email\` (\`email\`),
        INDEX \`idx_status\` (\`status\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
		console.log("✅ users 表已建立");

		// 建立 modbus_device_types 表（設備類型：DI/DO or sensor）
		await connection.query(`
      CREATE TABLE IF NOT EXISTS \`modbus_device_types\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`name\` VARCHAR(50) NOT NULL UNIQUE,
        \`code\` VARCHAR(20) NOT NULL UNIQUE,
        \`description\` TEXT DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_code\` (\`code\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
		console.log("✅ modbus_device_types 表已建立");

		// 建立 modbus_device_models 表（設備型號）
		await connection.query(`
      CREATE TABLE IF NOT EXISTS \`modbus_device_models\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`name\` VARCHAR(100) NOT NULL,
        \`type_id\` INT UNSIGNED NOT NULL COMMENT '設備類型 ID (DI/DO or Sensor)',
        \`port\` INT UNSIGNED NOT NULL DEFAULT 502 COMMENT 'Modbus 端口',
        \`description\` TEXT DEFAULT NULL COMMENT '備註',
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_name\` (\`name\`),
        INDEX \`idx_type_id\` (\`type_id\`),
        INDEX \`idx_port\` (\`port\`),
        FOREIGN KEY (\`type_id\`) REFERENCES \`modbus_device_types\`(\`id\`) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
		console.log("✅ modbus_device_models 表已建立");

		// 如果 modbus_device_models 表已存在但沒有 type_id 和 port 欄位，則添加它們
		try {
			// 檢查欄位是否存在
			const [columns] = await connection.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = ? 
        AND TABLE_NAME = 'modbus_device_models' 
        AND COLUMN_NAME IN ('type_id', 'port')
      `, [config.database.database]);
			
			const existingColumns = columns.map(col => col.COLUMN_NAME);
			
			// 添加 type_id 欄位（如果不存在）
			if (!existingColumns.includes('type_id')) {
				await connection.query(`
          ALTER TABLE \`modbus_device_models\`
          ADD COLUMN \`type_id\` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '設備類型 ID' AFTER \`name\`
        `);
				console.log("✅ 已添加 type_id 欄位到 modbus_device_models 表");
			}
			
			// 添加 port 欄位（如果不存在）
			if (!existingColumns.includes('port')) {
				await connection.query(`
          ALTER TABLE \`modbus_device_models\`
          ADD COLUMN \`port\` INT UNSIGNED NOT NULL DEFAULT 502 COMMENT 'Modbus 端口' AFTER \`type_id\`
        `);
				console.log("✅ 已添加 port 欄位到 modbus_device_models 表");
			}
			
			// 檢查並添加索引
			const [indexes] = await connection.query(`
        SELECT INDEX_NAME 
        FROM INFORMATION_SCHEMA.STATISTICS 
        WHERE TABLE_SCHEMA = ? 
        AND TABLE_NAME = 'modbus_device_models' 
        AND INDEX_NAME IN ('idx_type_id', 'idx_port')
      `, [config.database.database]);
			
			const existingIndexes = indexes.map(idx => idx.INDEX_NAME);
			
			if (!existingIndexes.includes('idx_type_id')) {
				await connection.query(`
          ALTER TABLE \`modbus_device_models\`
          ADD INDEX \`idx_type_id\` (\`type_id\`)
        `);
			}
			
			if (!existingIndexes.includes('idx_port')) {
				await connection.query(`
          ALTER TABLE \`modbus_device_models\`
          ADD INDEX \`idx_port\` (\`port\`)
        `);
			}
			
			// 檢查並添加外鍵
			const [foreignKeys] = await connection.query(`
        SELECT CONSTRAINT_NAME 
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = ? 
        AND TABLE_NAME = 'modbus_device_models' 
        AND CONSTRAINT_NAME = 'fk_model_type'
      `, [config.database.database]);
			
			if (foreignKeys.length === 0) {
				await connection.query(`
          ALTER TABLE \`modbus_device_models\`
          ADD CONSTRAINT \`fk_model_type\` FOREIGN KEY (\`type_id\`) REFERENCES \`modbus_device_types\`(\`id\`) ON DELETE RESTRICT
        `);
				console.log("✅ 已添加外鍵約束到 modbus_device_models 表");
			}
			
			console.log("✅ modbus_device_models 表的欄位已更新");
		} catch (error) {
			console.warn("⚠️  更新 modbus_device_models 欄位時出現警告:", error.message);
		}

		// 建立 modbus_ports 表（端口配置）
		await connection.query(`
      CREATE TABLE IF NOT EXISTS \`modbus_ports\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`port\` INT UNSIGNED NOT NULL UNIQUE,
        \`name\` VARCHAR(50) DEFAULT NULL,
        \`description\` TEXT DEFAULT NULL,
        \`is_default\` BOOLEAN NOT NULL DEFAULT FALSE,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_port\` (\`port\`),
        INDEX \`idx_is_default\` (\`is_default\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
		console.log("✅ modbus_ports 表已建立");

		// 建立 devices 表（修改後版本，加入型號和類型外鍵）
		await connection.query(`
      CREATE TABLE IF NOT EXISTS \`devices\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`name\` VARCHAR(100) NOT NULL,
        \`model_id\` INT UNSIGNED DEFAULT NULL,
        \`type_id\` INT UNSIGNED NOT NULL,
        \`device_type\` VARCHAR(50) DEFAULT NULL,
        \`modbus_host\` VARCHAR(255) NOT NULL,
        \`modbus_port\` INT UNSIGNED NOT NULL COMMENT '端口由型號綁定，從 model 繼承',
        \`port_id\` INT UNSIGNED DEFAULT NULL,
        \`modbus_unit_id\` INT UNSIGNED NOT NULL,
        \`location\` VARCHAR(255) DEFAULT NULL,
        \`description\` TEXT DEFAULT NULL,
        \`status\` ENUM('active', 'inactive', 'error') NOT NULL DEFAULT 'inactive',
        \`last_seen_at\` TIMESTAMP NULL DEFAULT NULL,
        \`created_by\` INT UNSIGNED DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_modbus_connection\` (\`modbus_host\`, \`modbus_port\`, \`modbus_unit_id\`),
        INDEX \`idx_status\` (\`status\`),
        INDEX \`idx_type_id\` (\`type_id\`),
        INDEX \`idx_model_id\` (\`model_id\`),
        INDEX \`idx_device_type\` (\`device_type\`),
        FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL,
        FOREIGN KEY (\`model_id\`) REFERENCES \`modbus_device_models\`(\`id\`) ON DELETE SET NULL,
        FOREIGN KEY (\`type_id\`) REFERENCES \`modbus_device_types\`(\`id\`) ON DELETE RESTRICT,
        FOREIGN KEY (\`port_id\`) REFERENCES \`modbus_ports\`(\`id\`) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
		console.log("✅ devices 表已建立");

		// 如果 devices 表已存在但沒有 device_type 欄位，則添加它
		try {
			await connection.query(`
        ALTER TABLE \`devices\` 
        ADD COLUMN IF NOT EXISTS \`device_type\` VARCHAR(50) DEFAULT NULL AFTER \`type_id\`,
        ADD INDEX IF NOT EXISTS \`idx_device_type\` (\`device_type\`)
      `);
			console.log("✅ devices 表的 device_type 欄位已更新");
		} catch (error) {
			// MySQL 不支援 IF NOT EXISTS，所以如果欄位已存在會報錯，這是正常的
			if (!error.message.includes("Duplicate column name")) {
				console.warn("⚠️  更新 device_type 欄位時出現警告:", error.message);
			}
		}

		// 建立 modbus_device_addresses 表（儲存 DI/DO 位址等內層資料）
		await connection.query(`
      CREATE TABLE IF NOT EXISTS \`modbus_device_addresses\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`device_id\` INT UNSIGNED NOT NULL,
        \`register_type\` ENUM('coil', 'discrete', 'holding', 'input') NOT NULL,
        \`address\` INT UNSIGNED NOT NULL,
        \`length\` INT UNSIGNED NOT NULL DEFAULT 1,
        \`name\` VARCHAR(100) DEFAULT NULL,
        \`description\` TEXT DEFAULT NULL,
        \`is_active\` BOOLEAN NOT NULL DEFAULT TRUE,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_device_register\` (\`device_id\`, \`register_type\`),
        INDEX \`idx_address\` (\`address\`),
        INDEX \`idx_is_active\` (\`is_active\`),
        FOREIGN KEY (\`device_id\`) REFERENCES \`devices\`(\`id\`) ON DELETE CASCADE,
        UNIQUE KEY \`unique_device_register_address\` (\`device_id\`, \`register_type\`, \`address\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
		console.log("✅ modbus_device_addresses 表已建立");

		// 插入預設的設備類型資料
		const deviceTypes = [
			{ name: "DI/DO", code: "DI_DO", description: "數位輸入/輸出設備" },
			{ name: "Sensor", code: "SENSOR", description: "感測器設備" }
		];
		for (const type of deviceTypes) {
			await connection.query(
				"INSERT IGNORE INTO modbus_device_types (name, code, description) VALUES (?, ?, ?)",
				[type.name, type.code, type.description]
			);
		}
		console.log("✅ 預設設備類型資料已插入");

		// 插入預設的端口資料
		const ports = [
			{ port: 502, name: "Modbus TCP 標準端口", description: "Modbus TCP/IP 標準端口", is_default: true },
			{ port: 503, name: "Modbus TCP 備用端口", description: "Modbus TCP/IP 備用端口", is_default: false }
		];
		for (const portData of ports) {
			await connection.query(
				"INSERT IGNORE INTO modbus_ports (port, name, description, is_default) VALUES (?, ?, ?, ?)",
				[portData.port, portData.name, portData.description, portData.is_default]
			);
		}
		console.log("✅ 預設端口資料已插入");

		// 建立 device_data_logs 表（用於儲存歷史資料）
		await connection.query(`
      CREATE TABLE IF NOT EXISTS \`device_data_logs\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`device_id\` INT UNSIGNED NOT NULL,
        \`register_type\` ENUM('holding', 'input', 'coil', 'discrete') NOT NULL,
        \`address\` INT UNSIGNED NOT NULL,
        \`value\` JSON NOT NULL,
        \`recorded_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_device_recorded\` (\`device_id\`, \`recorded_at\`),
        INDEX \`idx_recorded_at\` (\`recorded_at\`),
        FOREIGN KEY (\`device_id\`) REFERENCES \`devices\`(\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
		console.log("✅ device_data_logs 表已建立");

		// 建立 device_alerts 表（用於告警記錄）
		await connection.query(`
      CREATE TABLE IF NOT EXISTS \`device_alerts\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`device_id\` INT UNSIGNED NOT NULL,
        \`alert_type\` ENUM('offline', 'error', 'threshold', 'maintenance') NOT NULL,
        \`severity\` ENUM('info', 'warning', 'error', 'critical') NOT NULL DEFAULT 'warning',
        \`message\` TEXT NOT NULL,
        \`resolved\` BOOLEAN NOT NULL DEFAULT FALSE,
        \`resolved_at\` TIMESTAMP NULL DEFAULT NULL,
        \`resolved_by\` INT UNSIGNED DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_device_resolved\` (\`device_id\`, \`resolved\`),
        INDEX \`idx_created_at\` (\`created_at\`),
        FOREIGN KEY (\`device_id\`) REFERENCES \`devices\`(\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`resolved_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
		console.log("✅ device_alerts 表已建立");

		console.log("\n🎉 資料庫 Schema 初始化完成！");
	} catch (error) {
		console.error("❌ 初始化資料庫 Schema 失敗:", error.message);
		throw error;
	} finally {
		if (connection) {
			await connection.end();
		}
	}
}

// 如果直接執行此腳本
if (require.main === module) {
	initSchema()
		.then(() => {
			console.log("初始化完成");
			process.exit(0);
		})
		.catch((error) => {
			console.error("初始化失敗:", error);
			process.exit(1);
		});
}

module.exports = initSchema;
