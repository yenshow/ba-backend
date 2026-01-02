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
    database: "postgres", // 連接到預設資料庫以建立目標資料庫
  });

  try {
    console.log("正在建立資料庫...");

    // 檢查資料庫是否存在
    const dbCheck = await pool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [config.database.database]
    );

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
      database: config.database.database,
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

    // 建立警報相關 ENUM 類型
    await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE alert_type AS ENUM ('offline', 'error', 'threshold');
			EXCEPTION
				WHEN duplicate_object THEN null;
			END $$;
		`);

    await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE alert_severity AS ENUM ('warning', 'error', 'critical');
			EXCEPTION
				WHEN duplicate_object THEN null;
			END $$;
		`);

    // 建立警報系統來源 ENUM
    await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE alert_source AS ENUM ('device', 'environment', 'lighting', 'hvac', 'fire', 'security');
			EXCEPTION
				WHEN duplicate_object THEN null;
			END $$;
		`);

    // 建立警報狀態 ENUM（狀態機，移除 pending）
    await targetPool.query(`
			DO $$ BEGIN
				CREATE TYPE alert_status AS ENUM ('active', 'resolved', 'ignored');
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

    // 建立 device_types 表（通用設備類型表）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS device_types (
				id SERIAL PRIMARY KEY,
				name VARCHAR(50) NOT NULL UNIQUE,
				code VARCHAR(20) NOT NULL UNIQUE,
				description TEXT,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await createUpdatedAtTrigger(targetPool, "device_types");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_device_types_code ON device_types(code);
		`);

    console.log("✅ device_types 表已建立");

    // 建立 device_models 表（通用設備型號表）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS device_models (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL,
				type_id INTEGER NOT NULL,
				description TEXT,
				config JSONB,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT fk_device_model_type FOREIGN KEY (type_id) REFERENCES device_types(id) ON DELETE RESTRICT
			)
		`);

    // 如果表已存在但沒有 port 欄位，添加它
    await targetPool.query(`
			DO $$ 
			BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'device_models' AND column_name = 'port'
				) THEN
					ALTER TABLE device_models ADD COLUMN port INTEGER NOT NULL DEFAULT 502;
					RAISE NOTICE '已添加 port 欄位到 device_models 表';
				END IF;
			END $$;
		`);

    await createUpdatedAtTrigger(targetPool, "device_models");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_device_models_name ON device_models(name);
			CREATE INDEX IF NOT EXISTS idx_device_models_type_id ON device_models(type_id);
			CREATE INDEX IF NOT EXISTS idx_device_models_port ON device_models(port);
		`);

    console.log("✅ device_models 表已建立");

    // 建立 devices 表
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS devices (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL,
				model_id INTEGER NOT NULL,
				type_id INTEGER NOT NULL,
				location VARCHAR(255),
				description TEXT,
				status device_status NOT NULL DEFAULT 'inactive',
				config JSONB,
				last_seen_at TIMESTAMP,
				created_by INTEGER,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT fk_devices_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
				CONSTRAINT fk_devices_model FOREIGN KEY (model_id) REFERENCES device_models(id) ON DELETE RESTRICT,
				CONSTRAINT fk_devices_type FOREIGN KEY (type_id) REFERENCES device_types(id) ON DELETE RESTRICT
			)
		`);

    await createUpdatedAtTrigger(targetPool, "devices");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
			CREATE INDEX IF NOT EXISTS idx_devices_type_id ON devices(type_id);
			CREATE INDEX IF NOT EXISTS idx_devices_model_id ON devices(model_id);
			CREATE INDEX IF NOT EXISTS idx_devices_config ON devices USING GIN (config);
		`);

    console.log("✅ devices 表已建立");

    // 預設設備類型資料
    const deviceTypes = [
      {
        name: "攝影機",
        code: "camera",
        description: "影像監控、車牌辨識、人流統計",
      },
      { name: "感測器", code: "sensor", description: "感測器設備" },
      { name: "控制器", code: "controller", description: "modbus" },
      { name: "平板", code: "tablet", description: "平板電腦設備" },
      {
        name: "網路裝置",
        code: "network",
        description: "路由器、交換器、無線基地台等網路設備",
      },
    ];

    // 插入預設的設備類型資料到 device_types 表
    for (const type of deviceTypes) {
      try {
        await targetPool.query(
          `INSERT INTO device_types (name, code, description) 
					 VALUES ($1, $2, $3) 
					 ON CONFLICT (code) DO NOTHING`,
          [type.name, type.code, type.description]
        );
      } catch (error) {
        // 如果因為 name 衝突而失敗，嘗試使用 code 衝突處理
        if (
          error.code === "23505" &&
          error.constraint === "device_types_name_key"
        ) {
          // 名稱已存在，跳過
          continue;
        }
        throw error;
      }
    }
    console.log("✅ 預設設備類型資料已插入到 device_types");

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

    // 建立統一警報表（支持多系統來源，精簡版）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS alerts (
				id SERIAL PRIMARY KEY,
				source alert_source NOT NULL,
				source_id INTEGER NOT NULL,
				alert_type alert_type NOT NULL,
				severity alert_severity NOT NULL DEFAULT 'warning',
				message TEXT NOT NULL,
				status alert_status NOT NULL DEFAULT 'active',
				resolved_at TIMESTAMP,
				resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				ignored_at TIMESTAMP,
				ignored_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

    // 精簡後的索引（只保留核心索引）
    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_alerts_source_composite ON alerts(source, source_id, alert_type, status);
			CREATE UNIQUE INDEX IF NOT EXISTS unique_active_alert ON alerts(source, source_id, alert_type) WHERE status = 'active';
			CREATE INDEX IF NOT EXISTS idx_alerts_status_created ON alerts(status, created_at DESC) WHERE status = 'active';
			CREATE INDEX IF NOT EXISTS idx_alerts_updated_at ON alerts(updated_at DESC);
		`);

    await createUpdatedAtTrigger(targetPool, "alerts");

    console.log("✅ alerts 表已建立（統一警報系統）");

    // 建立錯誤追蹤表（持久化錯誤狀態）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS error_tracking (
				id SERIAL PRIMARY KEY,
				source alert_source NOT NULL,
				source_id INTEGER NOT NULL,
				error_count INTEGER NOT NULL DEFAULT 0,
				last_error_at TIMESTAMP,
				alert_created BOOLEAN NOT NULL DEFAULT FALSE,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(source, source_id)
			)
		`);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_error_tracking_source ON error_tracking(source, source_id);
			CREATE INDEX IF NOT EXISTS idx_error_tracking_alert_created ON error_tracking(alert_created);
		`);

    await createUpdatedAtTrigger(targetPool, "error_tracking");

    console.log("✅ error_tracking 表已建立（錯誤追蹤持久化）");

    // 建立警報規則參照表（alert_rules）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS alert_rules (
				id SERIAL PRIMARY KEY,
				source alert_source NOT NULL,
				alert_type alert_type NOT NULL,
				severity alert_severity NOT NULL,
				condition_type VARCHAR(50),
				condition_config JSONB,
				message_template TEXT,
				enabled BOOLEAN DEFAULT TRUE,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_alert_rules_source_type ON alert_rules(source, alert_type);
			CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
		`);

    await createUpdatedAtTrigger(targetPool, "alert_rules");

    console.log("✅ alert_rules 表已建立（警報規則參照表）");

    // 建立警報歷史記錄表（alert_history）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS alert_history (
				id SERIAL PRIMARY KEY,
				alert_id INTEGER REFERENCES alerts(id) ON DELETE CASCADE,
				old_status alert_status,
				new_status alert_status,
				changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				reason TEXT
			)
		`);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id);
			CREATE INDEX IF NOT EXISTS idx_alert_history_changed_at ON alert_history(changed_at DESC);
		`);

    console.log("✅ alert_history 表已建立（警報歷史記錄）");

    // 建立 lighting_categories 表（照明系統分類點）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS lighting_categories (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL,
				floor_id VARCHAR(50) NOT NULL,
				location_x DECIMAL(5,2) NOT NULL,
				location_y DECIMAL(5,2) NOT NULL,
				description TEXT,
				device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
				modbus_config JSONB NOT NULL DEFAULT '{}'::jsonb,
				room_ids INTEGER[] DEFAULT ARRAY[]::INTEGER[],
				status VARCHAR(50) DEFAULT 'active',
				created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await createUpdatedAtTrigger(targetPool, "lighting_categories");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_floor_id ON lighting_categories(floor_id);
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_device_id ON lighting_categories(device_id);
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_modbus_config ON lighting_categories USING GIN(modbus_config);
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_status ON lighting_categories(status);
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_created_at ON lighting_categories(created_at);
		`);

    console.log("✅ lighting_categories 表已建立");

    // 建立 lighting_floors 表（照明系統樓層）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS lighting_floors (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL UNIQUE,
				image_url TEXT,
				created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await createUpdatedAtTrigger(targetPool, "lighting_floors");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_lighting_floors_name ON lighting_floors(name);
		`);

    console.log("✅ lighting_floors 表已建立");

    // 建立 lighting_areas 表（照明系統區域，原分類點）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS lighting_areas (
				id SERIAL PRIMARY KEY,
				floor_id INTEGER NOT NULL REFERENCES lighting_floors(id) ON DELETE CASCADE,
				name VARCHAR(100) NOT NULL,
				location_x DECIMAL(5,2) NOT NULL DEFAULT 50.00,
				location_y DECIMAL(5,2) NOT NULL DEFAULT 50.00,
				device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
				modbus_config JSONB NOT NULL DEFAULT '{}'::jsonb,
				created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT unique_floor_area_name UNIQUE(floor_id, name)
			)
		`);

    // 移除已存在資料庫中的 description 欄位（如果存在）
    await targetPool.query(`
			DO $$ 
			BEGIN
				IF EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'lighting_areas' AND column_name = 'description'
				) THEN
					ALTER TABLE lighting_areas DROP COLUMN description;
				END IF;
			END $$;
		`);

    await createUpdatedAtTrigger(targetPool, "lighting_areas");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_lighting_areas_floor_id ON lighting_areas(floor_id);
			CREATE INDEX IF NOT EXISTS idx_lighting_areas_device_id ON lighting_areas(device_id);
			CREATE INDEX IF NOT EXISTS idx_lighting_areas_modbus_config ON lighting_areas USING GIN(modbus_config);
		`);

    console.log("✅ lighting_areas 表已建立");

    // 建立 environment_floors 表（環境監測樓層）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS environment_floors (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL UNIQUE,
				created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await createUpdatedAtTrigger(targetPool, "environment_floors");

    // 移除已存在資料庫中的 image_url 和 description 欄位（如果存在）
    await targetPool.query(`
			DO $$ 
			BEGIN
				IF EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'environment_floors' AND column_name = 'image_url'
				) THEN
					ALTER TABLE environment_floors DROP COLUMN image_url;
				END IF;
				IF EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'environment_floors' AND column_name = 'description'
				) THEN
					ALTER TABLE environment_floors DROP COLUMN description;
				END IF;
			END $$;
		`);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_environment_floors_name ON environment_floors(name);
		`);

    console.log("✅ environment_floors 表已建立");

    // 建立 environment_locations 表（環境監測位置）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS environment_locations (
				id SERIAL PRIMARY KEY,
				floor_id INTEGER NOT NULL REFERENCES environment_floors(id) ON DELETE CASCADE,
				name VARCHAR(100) NOT NULL,
				device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
				parameters JSONB NOT NULL DEFAULT '[]'::jsonb,
				created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT unique_floor_location_name UNIQUE(floor_id, name)
			)
		`);

    // 移除已存在資料庫中的 floor 欄位（如果存在，用於向後兼容）
    await targetPool.query(`
			DO $$ 
			BEGIN
				IF EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'environment_locations' AND column_name = 'floor'
				) THEN
					ALTER TABLE environment_locations DROP COLUMN floor;
					RAISE NOTICE '已移除 environment_locations.floor 欄位';
				END IF;
			END $$;
		`);

    await createUpdatedAtTrigger(targetPool, "environment_locations");

    // 移除已存在資料庫中的 description 欄位（如果存在）
    await targetPool.query(`
			DO $$ 
			BEGIN
				IF EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'environment_locations' AND column_name = 'description'
				) THEN
					ALTER TABLE environment_locations DROP COLUMN description;
				END IF;
			END $$;
		`);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_environment_locations_floor_id ON environment_locations(floor_id);
			CREATE INDEX IF NOT EXISTS idx_environment_locations_device_id ON environment_locations(device_id);
			CREATE INDEX IF NOT EXISTS idx_environment_locations_parameters ON environment_locations USING GIN(parameters);
		`);

    console.log("✅ environment_locations 表已建立");

    // 建立 sensor_readings 表（感測器讀數歷史資料）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS sensor_readings (
				id BIGSERIAL PRIMARY KEY,
				location_id INTEGER NOT NULL REFERENCES environment_locations(id) ON DELETE CASCADE,
				timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				data JSONB NOT NULL DEFAULT '{}'::jsonb,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_sensor_readings_location_id ON sensor_readings(location_id);
			CREATE INDEX IF NOT EXISTS idx_sensor_readings_timestamp ON sensor_readings(timestamp);
			CREATE INDEX IF NOT EXISTS idx_sensor_readings_location_timestamp ON sensor_readings(location_id, timestamp);
			CREATE INDEX IF NOT EXISTS idx_sensor_readings_data ON sensor_readings USING GIN(data);
		`);

    console.log("✅ sensor_readings 表已建立");

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
