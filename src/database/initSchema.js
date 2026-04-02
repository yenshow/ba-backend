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
          "drainage",
          "hvac",
          "fire",
          "emergency_rescue",
          "security",
        ],
      ],
      ["alert_status", ["active", "resolved", "ignored"]],
    ];
    for (const [name, values] of enums)
      await createEnum(targetPool, name, values);

    // 既有資料庫：alert_type ENUM 擴充（須單獨語句；不可包在含其它 DDL 的同一交易中）
    for (const v of ["di", "do"]) {
      try {
        await targetPool.query(`ALTER TYPE alert_type ADD VALUE '${v}'`);
      } catch (e) {
        const msg = e && e.message ? String(e.message) : "";
        if (!/already exists|duplicate/i.test(msg) && e.code !== "42710") {
          throw e;
        }
      }
    }

    // 建立 users 表（不含 email；討論決策：email 已自系統移除）
    await targetPool.query(`
			CREATE TABLE IF NOT EXISTS users (
				id SERIAL PRIMARY KEY,
				username VARCHAR(50) NOT NULL UNIQUE,
				password_hash VARCHAR(255) NOT NULL,
				role user_role NOT NULL DEFAULT 'viewer',
				status user_status NOT NULL DEFAULT 'active',
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

    // 遷移：若為舊版既有 DB（含 email 欄位），則移除 email 欄位與相關索引
    await targetPool.query(`
			ALTER TABLE users DROP COLUMN IF EXISTS email;
		`);
    await targetPool.query(`
			DROP INDEX IF EXISTS idx_users_email;
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

    console.log("✅ users 表已建立");

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
    console.log("✅ permission_definitions 表已建立");

    await targetPool.query(`
      CREATE TABLE IF NOT EXISTS role_default_permissions (
        id SERIAL PRIMARY KEY,
        role user_role NOT NULL,
        permission_id INTEGER NOT NULL REFERENCES permission_definitions(id) ON DELETE CASCADE,
        granted BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(role, permission_id)
      )
    `);
    await targetPool.query(`
      CREATE INDEX IF NOT EXISTS idx_role_default_permissions_role ON role_default_permissions(role);
    `);
    console.log("✅ role_default_permissions 表已建立");

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
    console.log("✅ user_permission_overrides 表已建立");

    // 種子：權限定義（system = 權限設定 UI「可使用的系統」四項；其餘供後端/既有邏輯用）
    const permissionSeeds = [
      {
        code: "system.people_counting",
        category: "system",
        parent_id: null,
        name: "人流統計",
        sort_order: 10,
      },
      {
        code: "system.video_surveillance",
        category: "system",
        parent_id: null,
        name: "影像監控",
        sort_order: 20,
      },
      {
        code: "system.environment",
        category: "system",
        parent_id: null,
        name: "環境品質",
        sort_order: 30,
      },
      {
        code: "system.vehicle_access",
        category: "system",
        parent_id: null,
        name: "車輛進出",
        sort_order: 40,
      },
      {
        code: "resource_monitoring.realtime_preview",
        category: "resource",
        parent_id: null,
        name: "即時預覽",
        sort_order: 10,
      },
      {
        code: "resource_monitoring.playback",
        category: "resource",
        parent_id: null,
        name: "播放",
        sort_order: 20,
      },
      {
        code: "resource_monitoring.export",
        category: "resource",
        parent_id: null,
        name: "錄影匯出",
        sort_order: 30,
      },
      {
        code: "resource_monitoring.ptz_control",
        category: "resource",
        parent_id: null,
        name: "PTZ 控制",
        sort_order: 40,
      },
      {
        code: "configuration.devices",
        category: "configuration",
        parent_id: null,
        name: "裝置和伺服器",
        sort_order: 10,
      },
      {
        code: "configuration.access_control",
        category: "configuration",
        parent_id: null,
        name: "門禁裝置",
        sort_order: 20,
      },
      {
        code: "operation.monitoring",
        category: "operation",
        parent_id: null,
        name: "資源監測（操作）",
        sort_order: 10,
      },
      {
        code: "operation.parking",
        category: "operation",
        parent_id: null,
        name: "停車場",
        sort_order: 20,
      },
      {
        code: "operation.alarm_center",
        category: "operation",
        parent_id: null,
        name: "警報中心",
        sort_order: 30,
      },
      {
        code: "operation.location_management",
        category: "operation",
        parent_id: null,
        name: "地點管理",
        sort_order: 40,
      },
    ];
    for (const p of permissionSeeds) {
      await targetPool.query(
        `INSERT INTO permission_definitions (code, category, parent_id, name, sort_order)
         SELECT $1, $2, $3, $4, $5
         ON CONFLICT (code) DO NOTHING`,
        [p.code, p.category, p.parent_id, p.name, p.sort_order],
      );
    }
    console.log("✅ 權限定義種子已插入");

    // 種子：角色預設權限（admin 全開由邏輯處理；此處為 operator/viewer 預設）
    const defRows = await targetPool.query(
      "SELECT id, code FROM permission_definitions",
    );
    const operatorGranted = [
      "system.people_counting",
      "system.video_surveillance",
      "system.environment",
      "system.vehicle_access",
      "resource_monitoring.realtime_preview",
      "resource_monitoring.playback",
      "operation.monitoring",
      "operation.parking",
      "operation.alarm_center",
      "operation.location_management",
      "configuration.access_control",
    ];
    const viewerGranted = [
      "system.people_counting",
      "system.video_surveillance",
      "resource_monitoring.realtime_preview",
      "resource_monitoring.playback",
      "operation.monitoring",
    ];
    for (const row of defRows.rows) {
      await targetPool.query(
        `INSERT INTO role_default_permissions (role, permission_id, granted)
         VALUES ('operator', $1, $2)
         ON CONFLICT (role, permission_id) DO NOTHING`,
        [row.id, operatorGranted.includes(row.code)],
      );
      await targetPool.query(
        `INSERT INTO role_default_permissions (role, permission_id, granted)
         VALUES ('viewer', $1, $2)
         ON CONFLICT (role, permission_id) DO NOTHING`,
        [row.id, viewerGranted.includes(row.code)],
      );
    }
    console.log("✅ 角色預設權限種子已插入");

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

    // 如果表已存在但沒有 port 欄位，添加它（可為 NULL，無預設值）
    await targetPool.query(`
			DO $$ 
			BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'device_models' AND column_name = 'port'
				) THEN
					ALTER TABLE device_models ADD COLUMN port INTEGER;
					RAISE NOTICE '已添加 port 欄位到 device_models 表';
				END IF;
			END $$;
		`);

    // 若 port 為 NOT NULL DEFAULT 502，改為可為 NULL、移除預設（型號端口改為留空）
    try {
      await targetPool.query(
        "ALTER TABLE device_models ALTER COLUMN port DROP DEFAULT",
      );
      await targetPool.query(
        "ALTER TABLE device_models ALTER COLUMN port DROP NOT NULL",
      );
    } catch (_) {}

    // 如果表已存在但沒有 unit_id 欄位，添加它（感測器/控制器等每設備可不同）
    await targetPool.query(`
			DO $$ 
			BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_name = 'device_models' AND column_name = 'unit_id'
				) THEN
					ALTER TABLE device_models ADD COLUMN unit_id INTEGER;
					RAISE NOTICE '已添加 unit_id 欄位到 device_models 表';
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

    // ISAPI 攝影機 PeopleCounting 事件（enter/exit 為設備累計；enter_delta/exit_delta 與前筆差）
    // 舊版曾使用 enter_abs/exit_abs 等欄位；執行 db:init 時偵測到舊表則 DROP 後重建（資料清空，請先備份）
    await targetPool.query(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'isapi_people_counting_events'
            AND column_name = 'enter_abs'
        ) THEN
          DROP TABLE IF EXISTS isapi_people_counting_events CASCADE;
        END IF;
      END
      $migration$;
    `);
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
      DROP INDEX IF EXISTS idx_isapi_people_counting_events_unique_global;
    `);
    await targetPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_isapi_people_counting_events_unique_region
      ON isapi_people_counting_events(device_id, channel_id, region_id, event_time)
      WHERE region_id IS NOT NULL;
    `);
    console.log("✅ isapi_people_counting_events 表已建立");

    // 車輛進出過車記錄快取表（同步自外部 vehiclebiz.passageway_log_data，供備份）
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
    console.log("✅ vehicle_passageway_logs 表已建立");

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

    // 兼容舊版資料：先補齊欄位，再建立依賴這些欄位的索引
    await targetPool.query(`
      ALTER TABLE alerts ADD COLUMN IF NOT EXISTS dimension_key VARCHAR(120) NOT NULL DEFAULT 'default';
      ALTER TABLE alerts ADD COLUMN IF NOT EXISTS rule_id INTEGER;
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

    console.log("✅ alerts 表已建立（統一警報系統）");

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

    // 向下相容：若從舊版升級（表已存在但無 alert_type），先補欄位再建索引
    await targetPool.query(`
      ALTER TABLE error_tracking ADD COLUMN IF NOT EXISTS alert_type VARCHAR(50) NOT NULL DEFAULT 'offline'
    `);
    // 移除舊的 UNIQUE(source, source_id) 約束（PostgreSQL 必須用 DROP CONSTRAINT）
    try {
      await targetPool.query(`
        ALTER TABLE error_tracking DROP CONSTRAINT IF EXISTS error_tracking_source_source_id_key
      `);
    } catch (_e) { /* 約束不存在（新表已用三欄約束），忽略 */ }
    await targetPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS error_tracking_source_source_id_alert_type_key
      ON error_tracking(source, source_id, alert_type)
    `);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_error_tracking_source ON error_tracking(source, source_id);
			CREATE INDEX IF NOT EXISTS idx_error_tracking_source_type ON error_tracking(source, source_id, alert_type);
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
        name VARCHAR(120),
        dimension_key VARCHAR(120),
        target_type VARCHAR(30),
        target_id INTEGER,
				condition_type VARCHAR(50),
				condition_config JSONB,
				message_template TEXT,
				enabled BOOLEAN DEFAULT TRUE,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

    // 遷移：既有 DB 補齊警報定義欄位（不破壞舊規則）
    await targetPool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'alert_rules' AND column_name = 'name'
        ) THEN
          ALTER TABLE alert_rules ADD COLUMN name VARCHAR(120);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'alert_rules' AND column_name = 'dimension_key'
        ) THEN
          ALTER TABLE alert_rules ADD COLUMN dimension_key VARCHAR(120);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'alert_rules' AND column_name = 'target_type'
        ) THEN
          ALTER TABLE alert_rules ADD COLUMN target_type VARCHAR(30);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'alert_rules' AND column_name = 'target_id'
        ) THEN
          ALTER TABLE alert_rules ADD COLUMN target_id INTEGER;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'alert_rules' AND column_name = 'message_template_key'
        ) THEN
          ALTER TABLE alert_rules ADD COLUMN message_template_key VARCHAR(64);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'alert_rules' AND column_name = 'message_template_custom'
        ) THEN
          ALTER TABLE alert_rules ADD COLUMN message_template_custom BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
      END $$;
    `);

    await targetPool.query(`
			CREATE INDEX IF NOT EXISTS idx_alert_rules_source_type ON alert_rules(source, alert_type);
			CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
      CREATE INDEX IF NOT EXISTS idx_alert_rules_target ON alert_rules(source, target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_alert_rules_dimension_key ON alert_rules(source, alert_type, dimension_key);
		`);

    await createUpdatedAtTrigger(targetPool, "alert_rules");

    console.log("✅ alert_rules 表已建立（警報規則參照表）");
    await targetPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_name = 'alerts'
            AND constraint_name = 'fk_alerts_rule_id'
        ) THEN
          ALTER TABLE alerts
          ADD CONSTRAINT fk_alerts_rule_id
          FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

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
    console.log("✅ alert_events 表已建立（警報事件流）");

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

    await targetPool.query(`
			DO $$ 
			BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_schema = 'public' AND table_name = 'zones' AND column_name = 'sort_order'
				) THEN
					ALTER TABLE zones ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
					UPDATE zones z SET sort_order = sub.rn FROM (
						SELECT id, (ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) - 1)::int AS rn FROM zones
					) sub WHERE z.id = sub.id;
					RAISE NOTICE '已添加 zones.sort_order 並回填（與舊版 created_at DESC 列表順序對齊）';
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
				sort_order INTEGER NOT NULL DEFAULT 0,
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

    await targetPool.query(`
			DO $$ 
			BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM information_schema.columns 
					WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'sort_order'
				) THEN
					ALTER TABLE locations ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
					UPDATE locations l SET sort_order = sub.rn FROM (
						SELECT id, (ROW_NUMBER() OVER (PARTITION BY zone_id ORDER BY created_at ASC, id ASC) - 1)::int AS rn FROM locations
					) sub WHERE l.id = sub.id;
					RAISE NOTICE '已添加 locations.sort_order 並回填（與舊版 created_at ASC 順序對齊）';
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
				system_type VARCHAR(50) NOT NULL CHECK (system_type IN ('environment', 'lighting', 'people_counting', 'vehicle_access', 'drainage', 'fire', 'emergency_rescue')),
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
				CHECK (system_type IN ('environment', 'lighting', 'people_counting', 'vehicle_access', 'drainage', 'fire', 'emergency_rescue'));
		`);

    // 既有資料庫：alert_source ENUM 擴充（須單獨語句；不可包在含其它 DDL 的同一交易中）
    try {
      await targetPool.query(`ALTER TYPE alert_source ADD VALUE 'drainage'`);
    } catch (e) {
      const msg = e && e.message ? String(e.message) : "";
      if (!/already exists|duplicate/i.test(msg) && e.code !== "42710") {
        throw e;
      }
    }
    try {
      await targetPool.query(`ALTER TYPE alert_source ADD VALUE 'emergency_rescue'`);
    } catch (e) {
      const msg = e && e.message ? String(e.message) : "";
      if (!/already exists|duplicate/i.test(msg) && e.code !== "42710") {
        throw e;
      }
    }

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

    // ISAPI 監聽主機收到之門禁事件（非 heartBeat），payload 存巢狀 AccessControllerEvent；附圖存 uploads/isapi-events，路徑存 picture_path
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
    console.log("✅ isapi_access_events 表已建立");

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
    console.log("✅ environment_readings_aggregated 表已建立");

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
