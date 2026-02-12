const { Pool } = require("pg");
const config = require("../config");

async function createUpdatedAtTrigger(pool, tableName) {
  await pool.query(`
    DROP TRIGGER IF EXISTS update_${tableName}_updated_at ON ${tableName};
    CREATE TRIGGER update_${tableName}_updated_at
      BEFORE UPDATE ON ${tableName} FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);
}

async function createEnum(pool, name, values) {
  const vals = values.map((v) => `'${v}'`).join(", ");
  await pool.query(`
    DO $$ BEGIN
      CREATE TYPE ${name} AS ENUM (${vals});
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
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
      [config.database.database],
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

    const enums = [
      ["user_role", ["admin", "operator", "viewer"]],
      ["user_status", ["active", "inactive", "suspended"]],
      ["device_status", ["active", "inactive", "error"]],
      ["register_type", ["coil", "discrete", "holding", "input"]],
      ["alert_type", ["offline", "error", "threshold"]],
      ["alert_severity", ["warning", "error", "critical"]],
      [
        "alert_source",
        [
          "device",
          "environment",
          "lighting",
          "people_counting",
          "hvac",
          "fire",
          "security",
        ],
      ],
      ["alert_status", ["active", "resolved", "ignored"]],
    ];
    for (const [name, values] of enums)
      await createEnum(targetPool, name, values);

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
      {
        name: "門禁設備",
        code: "access_control",
        description: "ISAPI 門禁／人臉設備",
      },
    ];

    // 插入預設的設備類型資料到 device_types 表
    for (const type of deviceTypes) {
      try {
        await targetPool.query(
          `INSERT INTO device_types (name, code, description) 
					 VALUES ($1, $2, $3) 
					 ON CONFLICT (code) DO NOTHING`,
          [type.name, type.code, type.description],
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

    // 人流統計刷卡記錄快取表（同步自外部 baseacs.slot_card_records，供備份）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS people_counting_logs (
        id BIGSERIAL PRIMARY KEY,
        external_id BIGINT,
        person_id INTEGER NOT NULL,
        swip_card_rev_time TIMESTAMPTZ NOT NULL,
        physical_id INTEGER,
        person_name VARCHAR(255),
        unit_id INTEGER,
        unit_name VARCHAR(255),
        snap_pic_url TEXT,
        location_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(person_id, swip_card_rev_time)
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_people_counting_logs_swip_time 
      ON people_counting_logs(swip_card_rev_time);
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_people_counting_logs_location 
      ON people_counting_logs(location_id);
    `);
    console.log("✅ people_counting_logs 表已建立");

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
				ignored_at TIMESTAMP,
				ignored_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);
    await targetPool.query(
      `ALTER TABLE alerts DROP COLUMN IF EXISTS resolved_by;`,
    );
    await targetPool.query(
      `ALTER TABLE alerts DROP COLUMN IF EXISTS resolved_at;`,
    );

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_alerts_source_composite ON alerts(source, source_id, alert_type, status);
			CREATE INDEX IF NOT EXISTS idx_alerts_active_daily ON alerts(source, source_id, alert_type, status, created_at) WHERE status = 'active';
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

    // 建立 lighting_categories 表
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS lighting_categories (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL,
				zone_id INTEGER REFERENCES zones(id) ON DELETE CASCADE,
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
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_zone_id ON lighting_categories(zone_id);
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_device_id ON lighting_categories(device_id);
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_modbus_config ON lighting_categories USING GIN(modbus_config);
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_status ON lighting_categories(status);
			CREATE INDEX IF NOT EXISTS idx_lighting_categories_created_at ON lighting_categories(created_at);
		`);

    console.log("✅ lighting_categories 表已建立");

    // ========== 統一地點管理架構 ==========

    // 建立統一的 zones 表
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS zones (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL UNIQUE,
				building_id INTEGER,
				image_url TEXT,
				description TEXT,
				created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await createUpdatedAtTrigger(targetPool, "zones");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_zones_name ON zones(name);
			CREATE INDEX IF NOT EXISTS idx_zones_building_id ON zones(building_id);
		`);

    // 如果表已存在，添加 image_url 欄位
    await targetPool.query(`
			DO $$ 
			BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'zones' AND column_name = 'image_url'
				) THEN
					ALTER TABLE zones ADD COLUMN image_url TEXT;
					RAISE NOTICE '已添加 zones.image_url 欄位';
				END IF;
			END $$;
		`);

    console.log("✅ zones 表已建立（統一區域表）");

    // 建立統一的 locations 表（統一地點表）
    // 注意：此表只存儲物理地點的基本資訊，不包含系統相關資訊
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS locations (
				id SERIAL PRIMARY KEY,
				zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
				name VARCHAR(100) NOT NULL,
				description TEXT,
				created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

    // 如果表已存在，遷移資料並移除舊欄位
    await targetPool.query(`
			DO $$ 
			BEGIN
				-- 如果缺少 description 欄位，添加它
				IF NOT EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'locations' AND column_name = 'description'
				) THEN
					ALTER TABLE locations ADD COLUMN description TEXT;
					RAISE NOTICE '已添加 locations.description 欄位';
				END IF;
			END $$;
		`);

    // 如果約束不存在，則添加約束
    await targetPool.query(`
			DO $$ 
			BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM pg_constraint 
					WHERE conname = 'unique_zone_location_name'
				) THEN
					ALTER TABLE locations 
					ADD CONSTRAINT unique_zone_location_name UNIQUE(zone_id, name);
					RAISE NOTICE '已添加 unique_zone_location_name 約束';
				ELSE
					RAISE NOTICE '約束 unique_zone_location_name 已存在，跳過';
				END IF;
			EXCEPTION
				WHEN duplicate_object THEN
					RAISE NOTICE '約束 unique_zone_location_name 已存在，跳過';
			END $$;
		`);

    await createUpdatedAtTrigger(targetPool, "locations");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_locations_zone_id ON locations(zone_id);
		`);

    console.log("✅ locations 表已建立（統一地點表）");

    // 建立 location_systems 表（地點系統關聯表）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS location_systems (
				id SERIAL PRIMARY KEY,
				location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
				system_type VARCHAR(50) NOT NULL CHECK (system_type IN ('environment', 'lighting', 'people_counting', 'vehicle_access')),
				system_config JSONB NOT NULL DEFAULT '{}'::jsonb,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(location_id, system_type)
			)
		`);

    // 若表已存在且為舊版 CHECK（無 vehicle_access），則擴充約束
    await targetPool.query(`
			ALTER TABLE location_systems DROP CONSTRAINT IF EXISTS location_systems_system_type_check;
			ALTER TABLE location_systems ADD CONSTRAINT location_systems_system_type_check
				CHECK (system_type IN ('environment', 'lighting', 'people_counting', 'vehicle_access'));
		`);

    await createUpdatedAtTrigger(targetPool, "location_systems");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_location_systems_location_id ON location_systems(location_id);
			CREATE INDEX IF NOT EXISTS idx_location_systems_system_type ON location_systems(system_type);
			CREATE INDEX IF NOT EXISTS idx_location_systems_config ON location_systems USING GIN(system_config);
		`);

    console.log("✅ location_systems 表已建立（地點系統關聯表）");

    // ========== 人員主檔與門禁權限（本系統） ==========
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await createUpdatedAtTrigger(targetPool, "person_groups");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_groups_name ON person_groups(name);
    `);
    console.log("✅ person_groups 表已建立");

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS persons (
        id SERIAL PRIMARY KEY,
        employee_no VARCHAR(64) NOT NULL UNIQUE,
        full_name VARCHAR(255),
        person_group_id INTEGER REFERENCES person_groups(id) ON DELETE SET NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        face_url TEXT,
        config JSONB,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await createUpdatedAtTrigger(targetPool, "persons");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_persons_person_group_id ON persons(person_group_id);
      CREATE INDEX IF NOT EXISTS idx_persons_status ON persons(status);
      CREATE INDEX IF NOT EXISTS idx_persons_employee_no ON persons(employee_no);
    `);
    console.log("✅ persons 表已建立");

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_location_access (
        id SERIAL PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(person_id, location_id)
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_location_access_location_id ON person_location_access(location_id);
      CREATE INDEX IF NOT EXISTS idx_person_location_access_person_id ON person_location_access(person_id);
    `);
    console.log("✅ person_location_access 表已建立");

    // 建立 environment_readings 表（環境品質系統感測器讀數，取代 device_data_logs）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS environment_readings (
        id BIGSERIAL PRIMARY KEY,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        source_id INTEGER NOT NULL,
        recorded_at TIMESTAMP NOT NULL,
        data JSONB NOT NULL,
        device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_environment_readings_location_recorded ON environment_readings(location_id, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_environment_readings_recorded_at ON environment_readings(recorded_at);
    `);
    console.log("✅ environment_readings 表已建立");

    await targetPool.query("DROP TABLE IF EXISTS device_data_logs CASCADE");

    // 建立 system_settings 表（系統設定表）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS system_settings (
				id SERIAL PRIMARY KEY,
				key VARCHAR(100) NOT NULL UNIQUE,
				value TEXT,
				description TEXT,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await createUpdatedAtTrigger(targetPool, "system_settings");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_system_settings_key ON system_settings(key);
		`);

    console.log("✅ system_settings 表已建立");

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
