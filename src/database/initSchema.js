const { Pool } = require("pg");
const config = require("../config");

// 建立 updated_at 觸發器的輔助函數
async function createUpdatedAtTrigger(pool, tableName) {
	await pool.query(`
		DROP TRIGGER IF EXISTS update_${tableName}_updated_at ON ${tableName};
		CREATE TRIGGER update_${tableName}_updated_at
			BEFORE UPDATE ON ${tableName}
			FOR EACH ROW
			EXECUTE FUNCTION update_updated_at_column();
	`);
}

async function initSchema() {
	const pool = new Pool({
		host: config.database.host,
		port: config.database.port,
		user: config.database.user,
		password: config.database.password,
		database: "postgres" // 連接到預設資料庫以建立目標資料庫
	});

	try {
		console.log("正在建立資料庫...");

		// 檢查資料庫是否存在
		const dbCheck = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [config.database.database]);

		if (dbCheck.rows.length === 0) {
			await pool.query(`CREATE DATABASE ${config.database.database}`);
			console.log(`✅ 資料庫 ${config.database.database} 已建立`);
		} else {
			console.log(`✅ 資料庫 ${config.database.database} 已存在`);
		}

		await pool.end();

		// 連接到目標資料庫
		const targetPool = new Pool({
			host: config.database.host,
			port: config.database.port,
			user: config.database.user,
			password: config.database.password,
			database: config.database.database
		});

		// 建立 ENUM 類型
		await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer');
			EXCEPTION
				WHEN duplicate_object THEN null;
			END $$;
		`);

		await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE user_status AS ENUM ('active', 'inactive', 'suspended');
			EXCEPTION
				WHEN duplicate_object THEN null;
			END $$;
		`);

		await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE device_status AS ENUM ('active', 'inactive', 'error');
			EXCEPTION
				WHEN duplicate_object THEN null;
			END $$;
		`);

		await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE register_type AS ENUM ('coil', 'discrete', 'holding', 'input');
			EXCEPTION
				WHEN duplicate_object THEN null;
			END $$;
		`);

		await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE alert_type AS ENUM ('offline', 'error', 'threshold', 'maintenance');
			EXCEPTION
				WHEN duplicate_object THEN null;
			END $$;
		`);

		await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE alert_severity AS ENUM ('info', 'warning', 'error', 'critical');
			EXCEPTION
				WHEN duplicate_object THEN null;
			END $$;
		`);

		// 建立 users 表
		await targetPool.query(`
			CREATE TABLE IF NOT EXISTS users (
				id SERIAL PRIMARY KEY,
				username VARCHAR(50) NOT NULL UNIQUE,
				email VARCHAR(100) NOT NULL UNIQUE,
				password_hash VARCHAR(255) NOT NULL,
				role user_role NOT NULL DEFAULT 'viewer',
				status user_status NOT NULL DEFAULT 'active',
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

		// 建立 updated_at 自動更新觸發器函數
		await targetPool.query(`
			CREATE OR REPLACE FUNCTION update_updated_at_column()
			RETURNS TRIGGER AS $$
			BEGIN
				NEW.updated_at = CURRENT_TIMESTAMP;
				RETURN NEW;
			END;
			$$ language 'plpgsql';
		`);

		// 為 users 表建立觸發器
		await createUpdatedAtTrigger(targetPool, "users");

		// 建立索引
		await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
			CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
			CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
		`);

		console.log("✅ users 表已建立");

		// 建立 modbus_device_types 表
		await targetPool.query(`
			CREATE TABLE IF NOT EXISTS modbus_device_types (
				id SERIAL PRIMARY KEY,
				name VARCHAR(50) NOT NULL UNIQUE,
				code VARCHAR(20) NOT NULL UNIQUE,
				description TEXT,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

		await createUpdatedAtTrigger(targetPool, "modbus_device_types");

		await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_modbus_device_types_code ON modbus_device_types(code);
		`);

		console.log("✅ modbus_device_types 表已建立");

		// 建立 modbus_device_models 表
		await targetPool.query(`
			CREATE TABLE IF NOT EXISTS modbus_device_models (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL,
				type_id INTEGER NOT NULL,
				port INTEGER NOT NULL DEFAULT 502,
				description TEXT,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT fk_model_type FOREIGN KEY (type_id) REFERENCES modbus_device_types(id) ON DELETE RESTRICT
			)
		`);

		await createUpdatedAtTrigger(targetPool, "modbus_device_models");

		await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_modbus_device_models_name ON modbus_device_models(name);
			CREATE INDEX IF NOT EXISTS idx_modbus_device_models_type_id ON modbus_device_models(type_id);
			CREATE INDEX IF NOT EXISTS idx_modbus_device_models_port ON modbus_device_models(port);
		`);

		console.log("✅ modbus_device_models 表已建立");

		// 建立 modbus_ports 表
		await targetPool.query(`
			CREATE TABLE IF NOT EXISTS modbus_ports (
				id SERIAL PRIMARY KEY,
				port INTEGER NOT NULL UNIQUE,
				name VARCHAR(50),
				description TEXT,
				is_default BOOLEAN NOT NULL DEFAULT FALSE,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

		await createUpdatedAtTrigger(targetPool, "modbus_ports");

		await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_modbus_ports_port ON modbus_ports(port);
			CREATE INDEX IF NOT EXISTS idx_modbus_ports_is_default ON modbus_ports(is_default);
		`);

		console.log("✅ modbus_ports 表已建立");

		// 建立 devices 表
		await targetPool.query(`
			CREATE TABLE IF NOT EXISTS devices (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL,
				model_id INTEGER,
				type_id INTEGER NOT NULL,
				device_type VARCHAR(50),
				modbus_host VARCHAR(255) NOT NULL,
				modbus_port INTEGER NOT NULL,
				port_id INTEGER,
				modbus_unit_id INTEGER NOT NULL,
				location VARCHAR(255),
				description TEXT,
				status device_status NOT NULL DEFAULT 'inactive',
				config JSONB,
				last_seen_at TIMESTAMP,
				created_by INTEGER,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT fk_devices_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
				CONSTRAINT fk_devices_model FOREIGN KEY (model_id) REFERENCES modbus_device_models(id) ON DELETE SET NULL,
				CONSTRAINT fk_devices_type FOREIGN KEY (type_id) REFERENCES modbus_device_types(id) ON DELETE RESTRICT,
				CONSTRAINT fk_devices_port FOREIGN KEY (port_id) REFERENCES modbus_ports(id) ON DELETE SET NULL
			)
		`);

		await createUpdatedAtTrigger(targetPool, "devices");

		await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_devices_modbus_connection ON devices(modbus_host, modbus_port, modbus_unit_id);
			CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
			CREATE INDEX IF NOT EXISTS idx_devices_type_id ON devices(type_id);
			CREATE INDEX IF NOT EXISTS idx_devices_model_id ON devices(model_id);
			CREATE INDEX IF NOT EXISTS idx_devices_device_type ON devices(device_type);
		`);

		console.log("✅ devices 表已建立");

		// 建立 modbus_device_addresses 表
		await targetPool.query(`
			CREATE TABLE IF NOT EXISTS modbus_device_addresses (
				id SERIAL PRIMARY KEY,
				device_id INTEGER NOT NULL,
				register_type register_type NOT NULL,
				address INTEGER NOT NULL,
				length INTEGER NOT NULL DEFAULT 1,
				name VARCHAR(100),
				description TEXT,
				is_active BOOLEAN NOT NULL DEFAULT TRUE,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT fk_addresses_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
				CONSTRAINT unique_device_register_address UNIQUE (device_id, register_type, address)
			)
		`);

		await createUpdatedAtTrigger(targetPool, "modbus_device_addresses");

		await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_modbus_device_addresses_device_register ON modbus_device_addresses(device_id, register_type);
			CREATE INDEX IF NOT EXISTS idx_modbus_device_addresses_address ON modbus_device_addresses(address);
			CREATE INDEX IF NOT EXISTS idx_modbus_device_addresses_is_active ON modbus_device_addresses(is_active);
		`);

		console.log("✅ modbus_device_addresses 表已建立");

		// 插入預設的設備類型資料
		const deviceTypes = [
			{ name: "DI/DO", code: "DI_DO", description: "數位輸入/輸出設備" },
			{ name: "Sensor", code: "SENSOR", description: "感測器設備" }
		];
		for (const type of deviceTypes) {
			await targetPool.query(
				`INSERT INTO modbus_device_types (name, code, description) 
				 VALUES ($1, $2, $3) 
				 ON CONFLICT (code) DO NOTHING`,
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
			await targetPool.query(
				`INSERT INTO modbus_ports (port, name, description, is_default) 
				 VALUES ($1, $2, $3, $4) 
				 ON CONFLICT (port) DO NOTHING`,
				[portData.port, portData.name, portData.description, portData.is_default]
			);
		}
		console.log("✅ 預設端口資料已插入");

		// 建立 device_data_logs 表
		await targetPool.query(`
			CREATE TABLE IF NOT EXISTS device_data_logs (
				id BIGSERIAL PRIMARY KEY,
				device_id INTEGER NOT NULL,
				register_type register_type NOT NULL,
				address INTEGER NOT NULL,
				value JSONB NOT NULL,
				recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT fk_logs_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
			)
		`);

		await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_device_data_logs_device_recorded ON device_data_logs(device_id, recorded_at);
			CREATE INDEX IF NOT EXISTS idx_device_data_logs_recorded_at ON device_data_logs(recorded_at);
		`);

		console.log("✅ device_data_logs 表已建立");

		// 建立 device_alerts 表
		await targetPool.query(`
			CREATE TABLE IF NOT EXISTS device_alerts (
				id SERIAL PRIMARY KEY,
				device_id INTEGER NOT NULL,
				alert_type alert_type NOT NULL,
				severity alert_severity NOT NULL DEFAULT 'warning',
				message TEXT NOT NULL,
				resolved BOOLEAN NOT NULL DEFAULT FALSE,
				resolved_at TIMESTAMP,
				resolved_by INTEGER,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT fk_alerts_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
				CONSTRAINT fk_alerts_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
			)
		`);

		await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_device_alerts_device_resolved ON device_alerts(device_id, resolved);
			CREATE INDEX IF NOT EXISTS idx_device_alerts_created_at ON device_alerts(created_at);
		`);

		console.log("✅ device_alerts 表已建立");

		await targetPool.end();

		console.log("\n🎉 資料庫 Schema 初始化完成！");
	} catch (error) {
		console.error("❌ 初始化資料庫 Schema 失敗:", error.message);
		throw error;
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
