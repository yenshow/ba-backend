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

		// 建立 devices 表
		await connection.query(`
      CREATE TABLE IF NOT EXISTS \`devices\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`name\` VARCHAR(100) NOT NULL,
        \`device_type\` VARCHAR(50) NOT NULL,
        \`modbus_host\` VARCHAR(255) NOT NULL,
        \`modbus_port\` INT UNSIGNED NOT NULL,
        \`modbus_unit_id\` INT UNSIGNED NOT NULL,
        \`location\` VARCHAR(255) DEFAULT NULL,
        \`description\` TEXT DEFAULT NULL,
        \`status\` ENUM('online', 'offline', 'maintenance', 'error') NOT NULL DEFAULT 'offline',
        \`last_seen_at\` TIMESTAMP NULL DEFAULT NULL,
        \`created_by\` INT UNSIGNED DEFAULT NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`idx_modbus_connection\` (\`modbus_host\`, \`modbus_port\`, \`modbus_unit_id\`),
        INDEX \`idx_status\` (\`status\`),
        INDEX \`idx_device_type\` (\`device_type\`),
        FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
		console.log("✅ devices 表已建立");

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
