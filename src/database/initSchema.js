const { Pool } = require("pg");
const config = require("../config");
const logger = require("../utils/logger");

const schemaLogger = logger.createLogger("initSchema");
const syncDefinitions = require("../access/syncDefinitions");

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
    schemaLogger.info("正在建立資料庫...", { module: "initSchema" });

    // 檢查資料庫是否存在
    const dbCheck = await pool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [config.database.database],
    );

    if (dbCheck.rows.length === 0) {
      await pool.query(`CREATE DATABASE ${config.database.database}`);
      schemaLogger.info(`資料庫 ${config.database.database} 已建立`, {
        module: "initSchema",
      });
    } else {
      schemaLogger.info(`資料庫 ${config.database.database} 已存在`, {
        module: "initSchema",
      });
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
      ["user_role", ["admin", "user"]],
      ["user_status", ["active", "inactive"]],
      ["register_type", ["coil", "discrete", "holding", "input"]],
      ["alert_type", ["offline", "error", "threshold", "di", "do"]],
      ["alert_severity", ["warning", "error", "critical"]],
      [
        "alert_source",
        [
          "device",
          "environment",
          "lighting",
          "people_counting",
          "drainage",
          "power",
          "hvac",
          "air_circulation",
          "fire",
          "emergency_rescue",
          "smoke_alarm",
          "security",
        ],
      ],
      ["alert_status", ["active", "resolved", "ignored"]],
    ];
    for (const [name, values] of enums)
      await createEnum(targetPool, name, values);

    const { ensureAlertSourceEnumValues } = require("./schemaPatches");
    await ensureAlertSourceEnumValues(targetPool);

    // 建立 users 表（不含 email；討論決策：email 已自系統移除）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS users (
				id SERIAL PRIMARY KEY,
				username VARCHAR(50) NOT NULL UNIQUE,
				password_hash VARCHAR(255) NOT NULL,
				role user_role NOT NULL DEFAULT 'user',
				status user_status NOT NULL DEFAULT 'active',
				token_version INTEGER NOT NULL DEFAULT 0,
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
			CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
		`);

    schemaLogger.info("users 表已建立", { module: "initSchema" });

    // ========== 精細權限（角色 + 權限覆寫） ==========
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS permission_definitions (
        id SERIAL PRIMARY KEY,
        code VARCHAR(100) NOT NULL UNIQUE,
        category VARCHAR(50) NOT NULL,
        parent_id INTEGER REFERENCES permission_definitions(id) ON DELETE CASCADE,
        name VARCHAR(255),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await createUpdatedAtTrigger(targetPool, "permission_definitions");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_permission_definitions_category ON permission_definitions(category);
      CREATE INDEX IF NOT EXISTS idx_permission_definitions_parent ON permission_definitions(parent_id);
    `);
    schemaLogger.info("permission_definitions 表已建立", {
      module: "initSchema",
    });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS user_permission_overrides (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission_id INTEGER NOT NULL REFERENCES permission_definitions(id) ON DELETE CASCADE,
        granted BOOLEAN NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, permission_id)
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user ON user_permission_overrides(user_id);
    `);
    schemaLogger.info("user_permission_overrides 表已建立", {
      module: "initSchema",
    });

    await syncDefinitions(targetPool);

    // 建立 device_models 表（通用設備型號表）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS device_models (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL,
				type_code VARCHAR(20) NOT NULL,
        category_code VARCHAR(50),
        port INTEGER,
        unit_id INTEGER,
				description TEXT,
				config JSONB,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT ck_device_models_type_code CHECK (type_code IN ('camera','sensor','controller','access_control'))
			)
		`);

    await createUpdatedAtTrigger(targetPool, "device_models");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_device_models_name ON device_models(name);
			CREATE INDEX IF NOT EXISTS idx_device_models_type_code ON device_models(type_code);
      CREATE INDEX IF NOT EXISTS idx_device_models_category_code ON device_models(category_code);
			CREATE INDEX IF NOT EXISTS idx_device_models_port ON device_models(port);
		`);

    // 這裡採用 (type_code, name) 唯一即可（型號字串本身為 SSOT，大小寫固定）
    await targetPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_device_models_type_name
      ON device_models (type_code, name);
    `);

    schemaLogger.info("device_models 表已建立", { module: "initSchema" });

    // 種子：門禁設備預設型號（可重跑，不重複）
    const accessControlModelSeeds = [
      { name: "YS AC-02F", type_code: "access_control" },
      { name: "YS AC-07", type_code: "access_control" },
    ];
    for (const m of accessControlModelSeeds) {
      await targetPool.query(
        `
          INSERT INTO device_models (name, type_code, category_code, description, config)
          VALUES ($1, $2, $3, $4, $5::jsonb)
          ON CONFLICT (type_code, name) DO UPDATE
          SET category_code = EXCLUDED.category_code,
              description = EXCLUDED.description,
              config = EXCLUDED.config,
              updated_at = CURRENT_TIMESTAMP
        `,
        [m.name, m.type_code, null, "門禁設備預設型號", "{}"],
      );
    }
    schemaLogger.info("device_models：門禁預設型號種子已插入", {
      module: "initSchema",
    });

    // 種子：控制器預設型號（可重跑、可覆蓋更新）
    const controllerModelSeeds = [
      {
        name: "YS-K2210",
        port: 8000,
        config: { protocol: "hcnet_sdk" },
        description: "HCNetSDK 梯控控制器",
      },
      {
        name: "ZC160",
        port: 502,
        config: {},
        description: "Modbus DI/DO 控制器",
      },
    ];
    for (const m of controllerModelSeeds) {
      await targetPool.query(
        `
          INSERT INTO device_models (name, type_code, category_code, description, port, config)
          VALUES ($1, 'controller', $2, $3, $4, $5::jsonb)
          ON CONFLICT (type_code, name) DO UPDATE
          SET port = EXCLUDED.port,
              description = EXCLUDED.description,
              config = EXCLUDED.config,
              updated_at = CURRENT_TIMESTAMP
        `,
        [m.name, null, m.description, m.port, JSON.stringify(m.config || {})],
      );
    }
    schemaLogger.info("device_models：控制器預設型號種子已插入", {
      module: "initSchema",
    });

    // 種子：攝影機預設型號（含分類；可重跑、可覆蓋更新）
    // category_code（互斥單選）：
    // - people_counting：人流統計
    // - license_plate_recognition：車牌辨識
    // - surveillance_2mp / 4mp / 5mp / 6mp / 8mp：影像監控（按解析度）
    const cameraModelSeeds = [
      // 人流統計
      { name: "YS-2CD3046G2H-IU", category_code: "people_counting" },
      { name: "YS-47-G0", category_code: "people_counting" },

      // 車牌辨識
      { name: "YS-46-G0", category_code: "license_plate_recognition" },
      { name: "YS-TCG405-E", category_code: "license_plate_recognition" },

      // 影像監控：2MP
      { name: "YS-2CD3021G0-IU(2.8mm)", category_code: "surveillance_2mp" },
      { name: "YS-2CD3321G2-IUF", category_code: "surveillance_2mp" },
      { name: "YS-2CD3T43G2-2ISU", category_code: "surveillance_2mp" },

      // 影像監控：4MP
      { name: "YS-2CD3047G2E-LUF", category_code: "surveillance_4mp" },
      { name: "YS-2CD2043G2-IU(4mm)", category_code: "surveillance_4mp" },
      { name: "YS-2CD3347G2E-LUF", category_code: "surveillance_4mp" },

      // 影像監控：5MP
      { name: "YS-2CD3151G0-I", category_code: "surveillance_5mp" },
      { name: "YS-2CD3051G0-IUF", category_code: "surveillance_5mp" },
      { name: "YS-2CD3956G2-IS(U)", category_code: "surveillance_5mp" },

      // 影像監控：6MP
      { name: "YS-2CD3661G2-LIZSU", category_code: "surveillance_6mp" },

      // 影像監控：8MP
      { name: "YS 4G-55", category_code: "surveillance_8mp" },
      { name: "YS-2CD3381G2P-LIUF/SL", category_code: "surveillance_8mp" },
    ];
    for (const m of cameraModelSeeds) {
      await targetPool.query(
        `
          INSERT INTO device_models (name, type_code, category_code, description, config)
          VALUES ($1, 'camera', $2, $3, $4::jsonb)
          ON CONFLICT (type_code, name) DO UPDATE
          SET category_code = EXCLUDED.category_code,
              description = EXCLUDED.description,
              config = EXCLUDED.config,
              updated_at = CURRENT_TIMESTAMP
        `,
        [m.name, m.category_code, "攝影機預設型號", "{}"],
      );
    }
    schemaLogger.info("device_models：攝影機預設型號（含分類）種子已插入", {
      module: "initSchema",
    });

    // 建立 devices 表
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS devices (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL,
				model_id INTEGER NOT NULL,
				type_code VARCHAR(20) NOT NULL,
				location VARCHAR(255),
				description TEXT,
				config JSONB,
				created_by INTEGER,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				CONSTRAINT fk_devices_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
				CONSTRAINT fk_devices_model FOREIGN KEY (model_id) REFERENCES device_models(id) ON DELETE RESTRICT,
				CONSTRAINT ck_devices_type_code CHECK (type_code IN ('camera','sensor','controller','access_control'))
			)
		`);

    await createUpdatedAtTrigger(targetPool, "devices");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_devices_type_code ON devices(type_code);
			CREATE INDEX IF NOT EXISTS idx_devices_model_id ON devices(model_id);
			CREATE INDEX IF NOT EXISTS idx_devices_config ON devices USING GIN (config);
		`);

    schemaLogger.info("devices 表已建立", { module: "initSchema" });

    // ========== 統一地點管理架構 ==========

    // 建立統一的 zones 表
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS zones (
				id SERIAL PRIMARY KEY,
				name VARCHAR(100) NOT NULL UNIQUE,
				building_id INTEGER,
				image_url TEXT,
				description TEXT,
				sort_order INTEGER NOT NULL DEFAULT 0,
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

    schemaLogger.info("zones 表已建立（統一區域表）", { module: "initSchema" });

    // 建立統一的 locations 表（統一地點表）
    // 注意：此表只存儲物理地點的基本資訊，不包含系統相關資訊
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS locations (
				id SERIAL PRIMARY KEY,
				zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
				name VARCHAR(100) NOT NULL,
				description TEXT,
				sort_order INTEGER NOT NULL DEFAULT 0,
				created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(zone_id, name)
			)
		`);

    await createUpdatedAtTrigger(targetPool, "locations");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_locations_zone_id ON locations(zone_id);
		`);

    schemaLogger.info("locations 表已建立（統一地點表）", {
      module: "initSchema",
    });

    // 建立 location_systems 表（地點系統關聯表）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS location_systems (
				id SERIAL PRIMARY KEY,
				location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
				system_type VARCHAR(50) NOT NULL CHECK (system_type IN ('environment', 'lighting', 'hvac', 'air_circulation', 'people_counting', 'vehicle_access', 'drainage', 'power', 'fire', 'emergency_rescue', 'smoke_alarm', 'elevator')),
				system_config JSONB NOT NULL DEFAULT '{}'::jsonb,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(location_id, system_type)
			)
		`);

    await createUpdatedAtTrigger(targetPool, "location_systems");

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_location_systems_location_id ON location_systems(location_id);
			CREATE INDEX IF NOT EXISTS idx_location_systems_system_type ON location_systems(system_type);
			CREATE INDEX IF NOT EXISTS idx_location_systems_config ON location_systems USING GIN(system_config);
		`);

    schemaLogger.info("location_systems 表已建立（地點系統關聯表）", {
      module: "initSchema",
    });

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
    schemaLogger.info("people_counting_logs 表已建立", {
      module: "initSchema",
    });

    // ISAPI 攝影機 PeopleCounting 事件（enter/exit 為設備累計；enter_delta/exit_delta 與前筆差）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS isapi_people_counting_events (
        id BIGSERIAL PRIMARY KEY,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        device_ip VARCHAR(255),
        channel_id INTEGER NOT NULL DEFAULT 1,
        region_id INTEGER,
        region_name VARCHAR(255),
        event_time TIMESTAMPTZ NOT NULL,
        enter INTEGER,
        "exit" INTEGER,
        enter_delta INTEGER NOT NULL DEFAULT 0,
        exit_delta INTEGER NOT NULL DEFAULT 0,
        is_retransmission BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_isapi_people_counting_events_location_time
      ON isapi_people_counting_events(location_id, event_time DESC);
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_isapi_people_counting_events_device_time
      ON isapi_people_counting_events(device_id, channel_id, region_id, event_time DESC);
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_isapi_people_counting_events_region_name
      ON isapi_people_counting_events(region_name);
    `);
    await targetPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_isapi_people_counting_events_unique_region
      ON isapi_people_counting_events(device_id, channel_id, region_id, event_time)
      WHERE region_id IS NOT NULL;
    `);
    schemaLogger.info("isapi_people_counting_events 表已建立", {
      module: "initSchema",
    });

    // 車輛進出過車記錄（YSCP 同步 + ISAPI ANPR 落地）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_passageway_logs (
        id BIGSERIAL PRIMARY KEY,
        external_id BIGINT UNIQUE,
        trigger_time TIMESTAMPTZ NOT NULL,
        lane_id INTEGER,
        lane_name VARCHAR(255),
        license_plate VARCHAR(255),
        owner_name VARCHAR(255),
        allow_result SMALLINT,
        lane_type SMALLINT,
        vehicle_list_id INTEGER,
        vehicle_list_name VARCHAR(255),
        zone_name VARCHAR(255),
        location_name VARCHAR(255),
        location_id INTEGER,
        data_source VARCHAR(32) NOT NULL DEFAULT 'yscp',
        device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
        anpr_line VARCHAR(64),
        picture_path TEXT,
        file_count INTEGER NOT NULL DEFAULT 0,
        payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_passageway_logs_trigger_time
      ON vehicle_passageway_logs(trigger_time);
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_passageway_logs_location
      ON vehicle_passageway_logs(location_id);
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_passageway_logs_location_time
      ON vehicle_passageway_logs(location_id, trigger_time DESC);
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_passageway_logs_data_source
      ON vehicle_passageway_logs(data_source);
    `);
    schemaLogger.info("vehicle_passageway_logs 表已建立", {
      module: "initSchema",
    });

    // 車輛在場狀態（ISAPI；停車場／工地持續在場）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_presence (
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        plate_normalized VARCHAR(64) NOT NULL,
        is_present BOOLEAN NOT NULL DEFAULT false,
        last_event_time TIMESTAMPTZ,
        last_lane_type SMALLINT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (location_id, plate_normalized)
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_presence_location_present
      ON vehicle_presence(location_id) WHERE is_present = true
    `);

    // 停車場統計 Reset 稽核（可選）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_access_reset_log (
        id BIGSERIAL PRIMARY KEY,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        reset_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_access_reset_log_location
      ON vehicle_access_reset_log(location_id, reset_at DESC)
    `);

    // 人流統計 Reset 稽核（可選）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS people_counting_reset_log (
        id BIGSERIAL PRIMARY KEY,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        reset_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_people_counting_reset_log_location
      ON people_counting_reset_log(location_id, reset_at DESC)
    `);

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
        dimension_key VARCHAR(120) NOT NULL DEFAULT 'default',
        rule_id INTEGER,
				ignored_at TIMESTAMP,
				ignored_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_alerts_source_composite ON alerts(source, source_id, alert_type, status);
			CREATE INDEX IF NOT EXISTS idx_alerts_active_daily ON alerts(source, source_id, alert_type, status, created_at) WHERE status = 'active';
			CREATE INDEX IF NOT EXISTS idx_alerts_dimension_key ON alerts(source, source_id, alert_type, dimension_key, status);
			CREATE INDEX IF NOT EXISTS idx_alerts_status_created ON alerts(status, created_at DESC) WHERE status = 'active';
			CREATE INDEX IF NOT EXISTS idx_alerts_updated_at ON alerts(updated_at DESC);
		`);
    await targetPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_unique_active_key
      ON alerts(source, source_id, alert_type, dimension_key)
      WHERE status = 'active';
    `);

    await createUpdatedAtTrigger(targetPool, "alerts");

    schemaLogger.info("alerts 表已建立（統一警報系統）", {
      module: "initSchema",
    });

    // 建立錯誤追蹤表（持久化錯誤狀態）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS error_tracking (
				id SERIAL PRIMARY KEY,
				source alert_source NOT NULL,
				source_id INTEGER NOT NULL,
				alert_type VARCHAR(50) NOT NULL DEFAULT 'offline',
				error_count INTEGER NOT NULL DEFAULT 0,
				last_error_at TIMESTAMP,
				alert_created BOOLEAN NOT NULL DEFAULT FALSE,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(source, source_id, alert_type)
			)
		`);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_error_tracking_source ON error_tracking(source, source_id);
			CREATE INDEX IF NOT EXISTS idx_error_tracking_source_type ON error_tracking(source, source_id, alert_type);
			CREATE INDEX IF NOT EXISTS idx_error_tracking_alert_created ON error_tracking(alert_created);
		`);

    await createUpdatedAtTrigger(targetPool, "error_tracking");

    schemaLogger.info("error_tracking 表已建立（錯誤追蹤持久化）", {
      module: "initSchema",
    });

    // 建立警報規則參照表（alert_rules）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS alert_rules (
				id SERIAL PRIMARY KEY,
				source alert_source NOT NULL,
				alert_type alert_type NOT NULL,
				severity alert_severity NOT NULL,
        name VARCHAR(120),
        dimension_key VARCHAR(120),
        target_type VARCHAR(30),
        target_id INTEGER,
				condition_type VARCHAR(50),
				condition_config JSONB,
				message_template TEXT,
        message_suffix TEXT,
				enabled BOOLEAN DEFAULT TRUE,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_alert_rules_source_type ON alert_rules(source, alert_type);
			CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
      CREATE INDEX IF NOT EXISTS idx_alert_rules_target ON alert_rules(source, target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_alert_rules_dimension_key ON alert_rules(source, alert_type, dimension_key);
		`);

    await createUpdatedAtTrigger(targetPool, "alert_rules");

    schemaLogger.info("alert_rules 表已建立（警報規則參照表）", {
      module: "initSchema",
    });

    // 建立警報事件表（事件流）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS alert_events (
        id BIGSERIAL PRIMARY KEY,
        alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
        event_type VARCHAR(30) NOT NULL,
        old_status alert_status,
        new_status alert_status,
        payload JSONB,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_events_alert_id ON alert_events(alert_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_events_event_type ON alert_events(event_type, created_at DESC);
    `);
    schemaLogger.info("alert_events 表已建立（警報事件流）", {
      module: "initSchema",
    });

    // ========== 營運事件（與 alerts 分離；無 alert_id／無 linkage_write） ==========
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS operational_events (
        id BIGSERIAL PRIMARY KEY,
        occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        source VARCHAR(64) NOT NULL,
        event_kind VARCHAR(32) NOT NULL
          CHECK (event_kind IN (
            'control_write', 'state_change',
            'access', 'vehicle', 'elevator'
          )),
        location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
        system_id INTEGER REFERENCES location_systems(id) ON DELETE SET NULL,
        device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
        bit_key VARCHAR(64),
        address INTEGER,
        old_value BOOLEAN,
        new_value BOOLEAN,
        summary TEXT NOT NULL,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ref_table VARCHAR(64),
        ref_id BIGINT,
        payload JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_operational_events_occurred
        ON operational_events(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operational_events_source_occurred
        ON operational_events(source, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operational_events_kind_occurred
        ON operational_events(event_kind, occurred_at DESC);
    `);
    schemaLogger.info("operational_events 表已建立（營運事件）", {
      module: "initSchema",
    });

    // ========== 警報連動（掛載 alert_rules） ==========
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS alert_linkages (
        id SERIAL PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        do_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
        do_address INTEGER,
        do_output_value VARCHAR(8) NOT NULL DEFAULT 'on' CHECK (do_output_value IN ('on', 'off')),
        auto_off_seconds INTEGER,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await createUpdatedAtTrigger(targetPool, "alert_linkages");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_linkages_enabled ON alert_linkages(enabled);
      CREATE INDEX IF NOT EXISTS idx_alert_linkages_rule_id ON alert_linkages(rule_id);
      CREATE INDEX IF NOT EXISTS idx_alert_linkages_do_target ON alert_linkages(do_device_id, do_address);
    `);
    schemaLogger.info(
      "alert_linkages 表已建立（警報連動規則，綁定 alert_rules）",
      { module: "initSchema" },
    );

    // 連動執行記錄（稽核）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS alert_linkage_executions (
        id BIGSERIAL PRIMARY KEY,
        linkage_id INTEGER NOT NULL REFERENCES alert_linkages(id) ON DELETE CASCADE,
        alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
        execution_type VARCHAR(30) NOT NULL CHECK (execution_type IN ('trigger', 'auto_off', 'manual_trigger', 'manual_revert', 'rollover_revert')),
        do_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
        do_address INTEGER,
        do_value BOOLEAN,
        success BOOLEAN NOT NULL DEFAULT FALSE,
        error_message TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_linkage_executions_linkage ON alert_linkage_executions(linkage_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_linkage_executions_alert ON alert_linkage_executions(alert_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_linkage_executions_do_target ON alert_linkage_executions(do_device_id, do_address, created_at DESC);
    `);
    schemaLogger.info("alert_linkage_executions 表已建立（連動執行記錄）", {
      module: "initSchema",
    });

    // ========== 警報攝影機連動（rule_id -> camera device） ==========
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS alert_camera_linkages (
        id SERIAL PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        camera_device_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rule_id)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "alert_camera_linkages");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_camera_linkages_enabled ON alert_camera_linkages(enabled);
      CREATE INDEX IF NOT EXISTS idx_alert_camera_linkages_rule_id ON alert_camera_linkages(rule_id);
    `);
    schemaLogger.info("alert_camera_linkages 表已建立（攝影機連動）", {
      module: "initSchema",
    });

    // ========== 警報門禁全開連動（rule 啟用後對全部 access_control 送 alwaysOpen） ==========
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS alert_access_door_linkages (
        id SERIAL PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rule_id)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "alert_access_door_linkages");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_access_door_linkages_enabled ON alert_access_door_linkages(enabled);
      CREATE INDEX IF NOT EXISTS idx_alert_access_door_linkages_rule_id ON alert_access_door_linkages(rule_id);
    `);
    schemaLogger.info("alert_access_door_linkages 表已建立（門禁全開連動）", {
      module: "initSchema",
    });

    // ========== 警報外部通知（Email / SMTP，每規則獨立）==========
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS alert_email_subscriptions (
        id SERIAL PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        smtp_host TEXT,
        smtp_port INTEGER,
        smtp_user TEXT,
        smtp_password TEXT,
        smtp_security VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (smtp_security IN ('none', 'ssl', 'tls')),
        to_emails TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        repeat_min_interval_seconds INTEGER NOT NULL DEFAULT 15 CHECK (repeat_min_interval_seconds >= 15),
        repeat_max_send_count INTEGER NOT NULL DEFAULT 10 CHECK (repeat_max_send_count >= 1 AND repeat_max_send_count <= 10),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rule_id)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "alert_email_subscriptions");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_email_subscriptions_rule_id ON alert_email_subscriptions(rule_id);
      CREATE INDEX IF NOT EXISTS idx_alert_email_subscriptions_enabled ON alert_email_subscriptions(enabled);
    `);
    schemaLogger.info("alert_email_subscriptions 表已建立（Email 設定）", {
      module: "initSchema",
    });

    // 每筆警報（alert_id）+ 規則（rule_id）的寄送狀態（次數/時間）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS alert_email_send_state (
        id BIGSERIAL PRIMARY KEY,
        alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
        rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
        last_sent_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(alert_id, rule_id)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "alert_email_send_state");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_email_send_state_rule ON alert_email_send_state(rule_id, last_sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_email_send_state_alert ON alert_email_send_state(alert_id);
    `);
    schemaLogger.info("alert_email_send_state 表已建立（Email 寄送狀態）", {
      module: "initSchema",
    });

    // 同一 rule_id 的全域節流（兩封成功信最短間隔）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS alert_email_rule_throttle (
        rule_id INTEGER PRIMARY KEY REFERENCES alert_rules(id) ON DELETE CASCADE,
        last_success_sent_at TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await createUpdatedAtTrigger(targetPool, "alert_email_rule_throttle");
    schemaLogger.info("alert_email_rule_throttle 表已建立（Email 全域節流）", {
      module: "initSchema",
    });

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

    schemaLogger.info("lighting_categories 表已建立", { module: "initSchema" });

    // ========== 人員主檔與門禁權限（本系統） ==========
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        parent_id INTEGER REFERENCES person_groups(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await createUpdatedAtTrigger(targetPool, "person_groups");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_groups_name ON person_groups(name);
      CREATE INDEX IF NOT EXISTS idx_person_groups_parent_id ON person_groups(parent_id);
    `);
    schemaLogger.info("person_groups 表已建立", { module: "initSchema" });

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
    schemaLogger.info("persons 表已建立", { module: "initSchema" });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_license_plates (
        id SERIAL PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        plate_number VARCHAR(32) NOT NULL,
        plate_normalized VARCHAR(32) NOT NULL,
        list_type VARCHAR(16) NOT NULL DEFAULT 'allowList',
        effective_begin TIMESTAMPTZ,
        effective_end TIMESTAMPTZ,
        isapi_sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',
        isapi_sync_error TEXT,
        isapi_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (person_id, plate_normalized)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "person_license_plates");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_license_plates_normalized
      ON person_license_plates(plate_normalized);
    `);
    await targetPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_person_license_plates_normalized
      ON person_license_plates (plate_normalized);
    `);
    schemaLogger.info("person_license_plates 表已建立", {
      module: "initSchema",
    });

    // 人員梯控卡片（主檔；下發至 HCNetSDK 設備）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_ladder_cards (
        id SERIAL PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        card_no VARCHAR(64),
        home_floor SMALLINT NOT NULL DEFAULT 1,
        floors JSONB NOT NULL DEFAULT '[]',
        card_type SMALLINT NOT NULL DEFAULT 1,
        floor_mode VARCHAR(16) NOT NULL DEFAULT 'byte',
        card_password VARCHAR(32),
        valid_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        valid_begin TIMESTAMPTZ,
        valid_end TIMESTAMPTZ,
        sdk_sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',
        sdk_sync_error TEXT,
        sdk_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(person_id)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "person_ladder_cards");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_ladder_cards_card_no
      ON person_ladder_cards(card_no);
    `);
    schemaLogger.info("person_ladder_cards 表已建立", { module: "initSchema" });

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
    schemaLogger.info("person_location_access 表已建立", {
      module: "initSchema",
    });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_elevator_floor_access (
        id SERIAL PRIMARY KEY,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        floor_index SMALLINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(location_id, person_id, floor_index),
        CHECK (floor_index >= 1)
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_elevator_floor_access_location_id
      ON person_elevator_floor_access(location_id);
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_elevator_floor_access_location_floor
      ON person_elevator_floor_access(location_id, floor_index);
    `);
    schemaLogger.info("person_elevator_floor_access 表已建立", {
      module: "initSchema",
    });

    // 人員 × 門禁設備：同步狀態（用於差異同步與 UI 顯示已同步/失敗）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_device_sync_states (
        id BIGSERIAL PRIMARY KEY,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        employee_no VARCHAR(64) NOT NULL,

        user_info_hash TEXT,
        user_info_status VARCHAR(16),
        user_info_synced_at TIMESTAMPTZ,

        face_hash TEXT,
        face_status VARCHAR(16),
        face_synced_at TIMESTAMPTZ,

        card_hash TEXT,
        card_status VARCHAR(16),
        card_synced_at TIMESTAMPTZ,

        fingerprint_hash TEXT,
        fingerprint_status VARCHAR(16),
        fingerprint_synced_at TIMESTAMPTZ,
        fingerprint_detail JSONB,

        last_error_message TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(device_id, employee_no)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "person_device_sync_states");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_device_sync_states_device ON person_device_sync_states(device_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_person_device_sync_states_employee ON person_device_sync_states(employee_no);
    `);
    schemaLogger.info("person_device_sync_states 表已建立（門禁同步狀態）", {
      module: "initSchema",
    });

    // 人員門禁同步 job（持久化：取代 in-memory Map；供輪詢/稽核/重啟恢復）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_sync_jobs (
        job_id VARCHAR(80) PRIMARY KEY,
        job_type VARCHAR(24) NOT NULL CHECK (job_type IN ('sync_location', 'sync_all_locations', 'elevator_sync_location')),
        location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
        status VARCHAR(16) NOT NULL CHECK (status IN ('queued','running','completed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        progress JSONB NOT NULL DEFAULT '{}'::jsonb,
        items_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        result JSONB,
        error JSONB
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_sync_jobs_type_created
      ON person_sync_jobs(job_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_person_sync_jobs_location_created
      ON person_sync_jobs(location_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_person_sync_jobs_status_created
      ON person_sync_jobs(status, created_at DESC);
    `);
    schemaLogger.info("person_sync_jobs 表已建立（同步 job 持久化）", {
      module: "initSchema",
    });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_sync_job_items (
        id BIGSERIAL PRIMARY KEY,
        job_id VARCHAR(80) NOT NULL REFERENCES person_sync_jobs(job_id) ON DELETE CASCADE,
        item_type VARCHAR(16) NOT NULL CHECK (item_type IN ('issues','tail')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        payload JSONB NOT NULL
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_sync_job_items_job_type_id
      ON person_sync_job_items(job_id, item_type, id DESC);
      CREATE INDEX IF NOT EXISTS idx_person_sync_job_items_created_at
      ON person_sync_job_items(created_at DESC);
    `);
    schemaLogger.info("person_sync_job_items 表已建立（同步事件流）", {
      module: "initSchema",
    });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS person_sync_job_warnings (
        id BIGSERIAL PRIMARY KEY,
        job_id VARCHAR(80) NOT NULL REFERENCES person_sync_jobs(job_id) ON DELETE CASCADE,
        location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        payload JSONB NOT NULL
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_person_sync_job_warnings_job_id
      ON person_sync_job_warnings(job_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_person_sync_job_warnings_location_id
      ON person_sync_job_warnings(location_id, created_at DESC);
    `);
    schemaLogger.info("person_sync_job_warnings 表已建立（同步 warnings）", {
      module: "initSchema",
    });

    // ISAPI 監聽主機收到之門禁事件
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS isapi_access_events (
        id BIGSERIAL PRIMARY KEY,
        device_ip VARCHAR(45) NOT NULL,
        event_time TIMESTAMPTZ NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        picture_path TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_isapi_access_events_event_time ON isapi_access_events(event_time DESC);
      CREATE INDEX IF NOT EXISTS idx_isapi_access_events_device_ip ON isapi_access_events(device_ip);
      CREATE INDEX IF NOT EXISTS idx_isapi_access_events_payload ON isapi_access_events USING GIN (payload);
    `);
    schemaLogger.info("isapi_access_events 表已建立", { module: "initSchema" });

    // 梯控 SDK 佈防事件（僅寫入允許之 major/minor；供電梯模組查詢最新紀錄）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS ladder_sdk_events (
        id BIGSERIAL PRIMARY KEY,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        device_ip VARCHAR(45) NOT NULL,
        event_time TIMESTAMPTZ NOT NULL,
        major INTEGER NOT NULL,
        minor INTEGER NOT NULL,
        event_name VARCHAR(255),
        floor INTEGER,
        card_no VARCHAR(64),
        payload JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_ladder_sdk_events_event_time
      ON ladder_sdk_events(event_time DESC);
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_ladder_sdk_events_device_time
      ON ladder_sdk_events(device_id, event_time DESC);
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_ladder_sdk_events_card_no
      ON ladder_sdk_events(card_no)
      WHERE card_no IS NOT NULL AND card_no <> '';
    `);
    schemaLogger.info("ladder_sdk_events 表已建立", { module: "initSchema" });

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
    schemaLogger.info("environment_readings 表已建立", {
      module: "initSchema",
    });

    // 環境讀數彙總表（時/日/月，供趨勢與報表）
    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS environment_readings_aggregated (
        id BIGSERIAL PRIMARY KEY,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        bucket_type VARCHAR(10) NOT NULL,
        bucket_at TIMESTAMP NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(location_id, bucket_type, bucket_at)
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_env_agg_location_bucket ON environment_readings_aggregated(location_id, bucket_type, bucket_at);
    `);
    schemaLogger.info("environment_readings_aggregated 表已建立", {
      module: "initSchema",
    });

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

    schemaLogger.info("system_settings 表已建立", { module: "initSchema" });

    // ========== 外部整合：資料庫對接 / 記錄轉存（第一版：access_control） ==========

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS external_sync_configs (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(32) NOT NULL DEFAULT 'access_control' CHECK (event_type IN ('access_control')),
        push_time TIME NOT NULL,
        db_type VARCHAR(16) NOT NULL CHECK (db_type IN ('postgres','sqlserver','mysql')),
        host TEXT NOT NULL,
        port INTEGER NOT NULL CHECK (port >= 1 AND port <= 65535),
        database_name TEXT NOT NULL,
        username TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        target_table TEXT NOT NULL,
        cursor_ts TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(event_type)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "external_sync_configs");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_external_sync_configs_push_time
      ON external_sync_configs(push_time);
    `);
    schemaLogger.info("external_sync_configs 表已建立", { module: "initSchema" });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS external_sync_field_mappings (
        id SERIAL PRIMARY KEY,
        config_id INTEGER NOT NULL REFERENCES external_sync_configs(id) ON DELETE CASCADE,
        field_key VARCHAR(64) NOT NULL,
        target_column TEXT NOT NULL,
        format TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(config_id, field_key)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "external_sync_field_mappings");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_external_sync_field_mappings_config
      ON external_sync_field_mappings(config_id);
    `);
    schemaLogger.info("external_sync_field_mappings 表已建立", {
      module: "initSchema",
    });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS external_sync_run_logs (
        id BIGSERIAL PRIMARY KEY,
        config_id INTEGER NOT NULL REFERENCES external_sync_configs(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMPTZ,
        success BOOLEAN NOT NULL DEFAULT FALSE,
        row_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_external_sync_run_logs_config_time
      ON external_sync_run_logs(config_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_external_sync_run_logs_success
      ON external_sync_run_logs(success, started_at DESC);
    `);
    schemaLogger.info("external_sync_run_logs 表已建立", {
      module: "initSchema",
    });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS record_export_rules (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(32) NOT NULL DEFAULT 'access_control' CHECK (event_type IN ('access_control')),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        name TEXT NOT NULL,
        description TEXT,
        filename_prefix TEXT NOT NULL,
        date_format TEXT NOT NULL,
        time_format TEXT NOT NULL,
        output_format VARCHAR(8) NOT NULL CHECK (output_format IN ('csv','txt')),
        export_time TIME NOT NULL,
        storage_type VARCHAR(8) NOT NULL CHECK (storage_type IN ('local','sftp')),
        local_dir TEXT,
        sftp_host TEXT,
        sftp_port INTEGER CHECK (sftp_port IS NULL OR (sftp_port >= 1 AND sftp_port <= 65535)),
        sftp_username TEXT,
        sftp_password_enc TEXT,
        sftp_remote_dir TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await createUpdatedAtTrigger(targetPool, "record_export_rules");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_record_export_rules_event_enabled
      ON record_export_rules(event_type, enabled);
      CREATE INDEX IF NOT EXISTS idx_record_export_rules_export_time
      ON record_export_rules(export_time);
    `);
    schemaLogger.info("record_export_rules 表已建立", { module: "initSchema" });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS record_export_rule_groups (
        id SERIAL PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES record_export_rules(id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL REFERENCES person_groups(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rule_id, group_id)
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_record_export_rule_groups_rule
      ON record_export_rule_groups(rule_id);
      CREATE INDEX IF NOT EXISTS idx_record_export_rule_groups_group
      ON record_export_rule_groups(group_id);
    `);
    schemaLogger.info("record_export_rule_groups 表已建立", {
      module: "initSchema",
    });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS record_export_field_mappings (
        id SERIAL PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES record_export_rules(id) ON DELETE CASCADE,
        field_key VARCHAR(64) NOT NULL,
        header_label TEXT,
        format TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rule_id, field_key)
      )
    `);
    await createUpdatedAtTrigger(targetPool, "record_export_field_mappings");
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_record_export_field_mappings_rule
      ON record_export_field_mappings(rule_id, sort_order);
    `);
    schemaLogger.info("record_export_field_mappings 表已建立", {
      module: "initSchema",
    });

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS record_export_run_logs (
        id BIGSERIAL PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES record_export_rules(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMPTZ,
        success BOOLEAN NOT NULL DEFAULT FALSE,
        row_count INTEGER NOT NULL DEFAULT 0,
        file_paths TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_record_export_run_logs_rule_time
      ON record_export_run_logs(rule_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_record_export_run_logs_success
      ON record_export_run_logs(success, started_at DESC);
    `);
    schemaLogger.info("record_export_run_logs 表已建立", {
      module: "initSchema",
    });

    await targetPool.end();

    schemaLogger.info("資料庫 Schema 初始化完成", { module: "initSchema" });
  } catch (error) {
    schemaLogger.error("初始化資料庫 Schema 失敗", {
      error: error?.message || String(error),
      module: "initSchema",
    });
    throw error;
  }
}

// 如果直接執行此腳本
if (require.main === module) {
  initSchema()
    .then(() => {
      schemaLogger.info("初始化完成", { module: "initSchema" });
      process.exit(0);
    })
    .catch((error) => {
      schemaLogger.error("初始化失敗", {
        error: error?.message || String(error),
        module: "initSchema",
      });
      process.exit(1);
    });
}

module.exports = initSchema;
