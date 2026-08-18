/**
 * 既有資料庫 schema 增量修補（啟動時執行；新裝仍由 initSchema 建立完整 enum）。
 */
const logger = require("../utils/logger").createLogger("schemaPatches");
const {
  isValidSensorParameterKey,
} = require("../constants/environmentParameterCatalog");
const { syncDeviceModelCatalog, repairDeviceModelCatalogConfig } = require("./syncDeviceModelCatalog");

/** 與 initSchema `alert_source`、alertService.ALERT_SOURCES 對齊 */
const ALERT_SOURCE_ENUM_VALUES = [
  "device",
  "environment",
  "lighting",
  "people_counting",
  "drainage",
  "power",
  "energy",
  "hvac",
  "air_circulation",
  "fire",
  "emergency_rescue",
  "smoke_alarm",
  "security",
];

const sanitizeEnumName = (name) => String(name || "").replace(/[^a-z_]/gi, "");
const sanitizeEnumValue = (value) => String(value || "").replace(/'/g, "''");

async function ensureEnumValue(pool, enumName, value) {
  const safeEnum = sanitizeEnumName(enumName);
  const safeValue = sanitizeEnumValue(value);
  if (!safeEnum || !safeValue) return;

  await pool.query(`
    DO $do$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = '${safeEnum}')
         AND NOT EXISTS (
           SELECT 1
           FROM pg_enum e
           INNER JOIN pg_type t ON e.enumtypid = t.oid
           WHERE t.typname = '${safeEnum}'
             AND e.enumlabel = '${safeValue}'
         ) THEN
        ALTER TYPE ${safeEnum} ADD VALUE '${safeValue}';
      END IF;
    END
    $do$;
  `);
}

async function ensureAlertSourceEnumValues(pool) {
  for (const value of ALERT_SOURCE_ENUM_VALUES) {
    await ensureEnumValue(pool, "alert_source", value);
  }
}

async function createUpdatedAtTrigger(pool, tableName) {
  await pool.query(`
    DROP TRIGGER IF EXISTS update_${tableName}_updated_at ON ${tableName};
    CREATE TRIGGER update_${tableName}_updated_at
      BEFORE UPDATE ON ${tableName} FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);
}

async function ensureExternalIntegrationTables(pool) {
  const EVENT_TYPE_CHECK = `(
    'access_control','energy','operational','vehicle','people_counting','alerts','environment'
  )`;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS external_sync_configs (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(32) NOT NULL DEFAULT 'access_control',
      push_time TIME NOT NULL,
      db_type VARCHAR(16) NOT NULL CHECK (db_type IN ('postgres','sqlserver','mysql')),
      host TEXT NOT NULL,
      port INTEGER NOT NULL CHECK (port >= 1 AND port <= 65535),
      database_name TEXT NOT NULL,
      username TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      target_table TEXT NOT NULL,
      cursor_ts TIMESTAMPTZ,
      cursor_event_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_type)
    )
  `);
  await pool.query(`
    ALTER TABLE external_sync_configs
      ADD COLUMN IF NOT EXISTS cursor_event_id BIGINT
  `);
  await pool.query(`
    DO $$
    DECLARE cname text;
    BEGIN
      SELECT con.conname INTO cname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'external_sync_configs'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%event_type%';
      IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE external_sync_configs DROP CONSTRAINT %I', cname);
      END IF;
      ALTER TABLE external_sync_configs
        ADD CONSTRAINT external_sync_configs_event_type_check
        CHECK (event_type IN ${EVENT_TYPE_CHECK});
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END $$;
  `);
  await createUpdatedAtTrigger(pool, "external_sync_configs");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_external_sync_configs_push_time
    ON external_sync_configs(push_time);
  `);

  await pool.query(`
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
  await createUpdatedAtTrigger(pool, "external_sync_field_mappings");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_external_sync_field_mappings_config
    ON external_sync_field_mappings(config_id);
  `);

  await pool.query(`
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_external_sync_run_logs_config_time
    ON external_sync_run_logs(config_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_external_sync_run_logs_success
    ON external_sync_run_logs(success, started_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS record_export_rules (
      id SERIAL PRIMARY KEY,
      event_type VARCHAR(32) NOT NULL DEFAULT 'access_control',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      name TEXT NOT NULL,
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
      filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    ALTER TABLE record_export_rules
      ADD COLUMN IF NOT EXISTS filter_json JSONB NOT NULL DEFAULT '{}'::jsonb
  `);
  await pool.query(`
    ALTER TABLE record_export_rules
      DROP COLUMN IF EXISTS description
  `);
  await pool.query(`
    DO $$
    DECLARE cname text;
    BEGIN
      SELECT con.conname INTO cname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'record_export_rules'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%event_type%';
      IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE record_export_rules DROP CONSTRAINT %I', cname);
      END IF;
      ALTER TABLE record_export_rules
        ADD CONSTRAINT record_export_rules_event_type_check
        CHECK (event_type IN ${EVENT_TYPE_CHECK});
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END $$;
  `);
  await createUpdatedAtTrigger(pool, "record_export_rules");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_record_export_rules_event_enabled
    ON record_export_rules(event_type, enabled);
    CREATE INDEX IF NOT EXISTS idx_record_export_rules_export_time
    ON record_export_rules(export_time);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS record_export_rule_groups (
      id SERIAL PRIMARY KEY,
      rule_id INTEGER NOT NULL REFERENCES record_export_rules(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES person_groups(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(rule_id, group_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_record_export_rule_groups_rule
    ON record_export_rule_groups(rule_id);
    CREATE INDEX IF NOT EXISTS idx_record_export_rule_groups_group
    ON record_export_rule_groups(group_id);
  `);

  // 遷移既有門禁規則群組 → filter_json.groupIds（須在 rule_groups 表建立後）
  await pool.query(`
    UPDATE record_export_rules r
    SET filter_json = jsonb_build_object(
      'groupIds',
      COALESCE((
        SELECT jsonb_agg(g.group_id ORDER BY g.group_id)
        FROM record_export_rule_groups g
        WHERE g.rule_id = r.id
      ), '[]'::jsonb)
    )
    WHERE r.event_type = 'access_control'
      AND (
        r.filter_json IS NULL
        OR r.filter_json = '{}'::jsonb
        OR NOT (r.filter_json ? 'groupIds')
      )
      AND EXISTS (
        SELECT 1 FROM record_export_rule_groups g WHERE g.rule_id = r.id
      )
  `);

  await pool.query(`
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
  await createUpdatedAtTrigger(pool, "record_export_field_mappings");
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_record_export_field_mappings_rule
    ON record_export_field_mappings(rule_id, sort_order);
  `);

  await pool.query(`
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_record_export_run_logs_rule_time
    ON record_export_run_logs(rule_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_record_export_run_logs_success
    ON record_export_run_logs(success, started_at DESC);
  `);
}

async function ensureOperationalEventsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS operational_events (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source VARCHAR(64) NOT NULL,
      event_kind VARCHAR(32) NOT NULL
        CHECK (event_kind IN (
          'control_write', 'state_change',
          'access', 'vehicle', 'elevator', 'intercom'
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_operational_events_occurred
      ON operational_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_operational_events_source_occurred
      ON operational_events(source, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_operational_events_kind_occurred
      ON operational_events(event_kind, occurred_at DESC);
  `);

  // 既有庫：移除 linkage_write／alert_id 相容殘留
  await pool.query(`
    DO $do$
    DECLARE
      r RECORD;
    BEGIN
      IF to_regclass('public.operational_events') IS NULL THEN
        RETURN;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'operational_events'
          AND column_name = 'alert_id'
      ) THEN
        EXECUTE 'DROP INDEX IF EXISTS idx_operational_events_alert_id';
        EXECUTE 'ALTER TABLE operational_events DROP COLUMN alert_id';
      END IF;

      UPDATE operational_events
      SET event_kind = 'control_write'
      WHERE event_kind = 'linkage_write';

      FOR r IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'operational_events'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%event_kind%'
      LOOP
        EXECUTE format(
          'ALTER TABLE operational_events DROP CONSTRAINT %I',
          r.conname
        );
      END LOOP;

      ALTER TABLE operational_events
        ADD CONSTRAINT operational_events_event_kind_check
        CHECK (event_kind IN (
          'control_write', 'state_change',
          'access', 'vehicle', 'elevator', 'intercom'
        ));
    END
    $do$;
  `);
}

async function migrateLegacySensorModelConfigs(pool) {
  const { rows } = await pool.query(`
    SELECT id, name, config
    FROM device_models
    WHERE type_code = 'sensor'
      AND config ? 'modbusPoints'
    ORDER BY id
  `);

  let migratedCount = 0;
  for (const row of rows) {
    const config =
      row.config && typeof row.config === "object" ? row.config : {};
    const legacyPoints = Array.isArray(config.modbusPoints)
      ? config.modbusPoints
      : [];
    let sensorParameters = config.sensorParameters;
    let registerType = config.registerType;

    if (!Array.isArray(sensorParameters)) {
      const convertedParameters = [];
      const registerTypes = new Set();

      for (const point of legacyPoints) {
        const type = String(point?.key || point?.type || "").trim();
        const address = Number(point?.address);
        const pointRegisterType = String(
          point?.registerType || point?.register_type || "holding",
        ).toLowerCase();

        if (
          !isValidSensorParameterKey(type) ||
          !Number.isInteger(address) ||
          address < 0
        ) {
          continue;
        }
        if (
          ["coils", "discrete", "holding", "input"].includes(pointRegisterType)
        ) {
          registerTypes.add(pointRegisterType);
        }

        const transform = String(point?.transform || "").trim();
        convertedParameters.push({
          type,
          modbusConfig: {
            address,
            ...(transform ? { transform } : {}),
          },
        });
      }

      if (registerTypes.size > 1) {
        logger.error("感測器舊型號混用多種 registerType，無法自動遷移", {
          module: "schemaPatches",
          modelId: row.id,
          modelName: row.name,
          registerTypes: [...registerTypes],
        });
        continue;
      }

      sensorParameters = convertedParameters;
      registerType = [...registerTypes][0] || "holding";
    }

    const nextConfig = {
      ...config,
      registerType: registerType || "holding",
      sensorParameters,
    };
    delete nextConfig.modbusPoints;
    await pool.query(
      "UPDATE device_models SET config = $1::jsonb WHERE id = $2",
      [JSON.stringify(nextConfig), row.id],
    );
    migratedCount += 1;
  }

  return migratedCount;
}

async function ensureEnergyTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS energy_readings (
      id BIGSERIAL PRIMARY KEY,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      recorded_at TIMESTAMP NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_energy_readings_device_recorded
      ON energy_readings(device_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_energy_readings_recorded_at
      ON energy_readings(recorded_at);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS energy_usage_aggregated (
      id BIGSERIAL PRIMARY KEY,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      bucket_type VARCHAR(10) NOT NULL,
      bucket_at TIMESTAMP NOT NULL,
      delta_energy_kwh DOUBLE PRECISION,
      delta_water_m3 DOUBLE PRECISION,
      tou_peak_kwh DOUBLE PRECISION,
      tou_semi_peak_kwh DOUBLE PRECISION,
      tou_off_peak_kwh DOUBLE PRECISION,
      max_power_kw DOUBLE PRECISION,
      max_demand_kw DOUBLE PRECISION,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(device_id, bucket_type, bucket_at)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_energy_agg_device_bucket
      ON energy_usage_aggregated(device_id, bucket_type, bucket_at);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS energy_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await createUpdatedAtTrigger(pool, "energy_settings");
  await pool.query(`
    INSERT INTO energy_settings (id, config)
    VALUES (1, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
}

/** 既有庫：設備／型號 type_code 加 video_intercom */
async function ensureVideoIntercomTypeCode(pool) {
  await pool.query(`
    DO $do$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT c.conname, t.relname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname IN ('devices', 'device_models')
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%type_code%'
      LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.relname, r.conname);
      END LOOP;

      IF to_regclass('public.devices') IS NOT NULL THEN
        ALTER TABLE devices
          ADD CONSTRAINT ck_devices_type_code
          CHECK (type_code IN ('camera','sensor','controller','access_control','video_intercom'));
      END IF;
      IF to_regclass('public.device_models') IS NOT NULL THEN
        ALTER TABLE device_models
          ADD CONSTRAINT ck_device_models_type_code
          CHECK (type_code IN ('camera','sensor','controller','access_control','video_intercom'));
      END IF;
    END
    $do$;
  `);
}

/** 既有庫：location_systems.system_type 加 access_security */
async function ensureAccessSecurityLocationSystemType(pool) {
  await pool.query(`
    DO $do$
    DECLARE
      r RECORD;
    BEGIN
      IF to_regclass('public.location_systems') IS NULL THEN
        RETURN;
      END IF;
      FOR r IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'location_systems'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%system_type%'
      LOOP
        EXECUTE format('ALTER TABLE location_systems DROP CONSTRAINT %I', r.conname);
      END LOOP;
      ALTER TABLE location_systems
        ADD CONSTRAINT location_systems_system_type_check
        CHECK (system_type IN (
          'environment', 'lighting', 'hvac', 'air_circulation',
          'people_counting', 'vehicle_access', 'drainage', 'power',
          'fire', 'emergency_rescue', 'smoke_alarm', 'elevator', 'access_security'
        ));
    END
    $do$;
  `);
}

/** 既有庫：警報 SIP 室內振鈴連動表 */
async function ensureAlertSipRingLinkagesTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_sip_ring_linkages (
      id SERIAL PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
      device_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(rule_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_alert_sip_ring_linkages_enabled ON alert_sip_ring_linkages(enabled);
    CREATE INDEX IF NOT EXISTS idx_alert_sip_ring_linkages_rule_id ON alert_sip_ring_linkages(rule_id);
  `);
}

/** 既有庫：警報門禁連動補 device_ids（空陣列＝全部門禁） */
async function ensureAlertAccessDoorDeviceIds(pool) {
  await pool.query(`
    DO $do$
    BEGIN
      IF to_regclass('public.alert_access_door_linkages') IS NULL THEN
        RETURN;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'alert_access_door_linkages'
          AND column_name = 'device_ids'
      ) THEN
        ALTER TABLE alert_access_door_linkages
          ADD COLUMN device_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
      END IF;
    END
    $do$;
  `);
}

/** 既有庫：補建人臉比對事件表（initSchema 已有；舊庫靠 patch） */
async function ensureIsapiFaceContrastEventsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS isapi_face_contrast_events (
      id BIGSERIAL PRIMARY KEY,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      device_ip VARCHAR(255),
      channel_id INTEGER NOT NULL DEFAULT 1,
      event_time TIMESTAMPTZ NOT NULL,
      event_type VARCHAR(64) NOT NULL DEFAULT 'alarmResult',
      similarity DOUBLE PRECISION,
      employee_no VARCHAR(64),
      person_name VARCHAR(255),
      pid VARCHAR(64),
      certificate_number VARCHAR(128),
      matched BOOLEAN NOT NULL DEFAULT TRUE,
      payload JSONB,
      picture_path TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_isapi_face_contrast_events_location_time
    ON isapi_face_contrast_events(location_id, event_time DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_isapi_face_contrast_events_device_time
    ON isapi_face_contrast_events(device_id, event_time DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_isapi_face_contrast_events_employee
    ON isapi_face_contrast_events(employee_no)
  `);
  await pool.query(`
    ALTER TABLE isapi_face_contrast_events
      ADD COLUMN IF NOT EXISTS picture_path TEXT
  `);
}

async function applySchemaPatches(pool) {
  if (!pool) return;
  await ensureAlertSourceEnumValues(pool);
  await ensureEnergyTables(pool);
  await ensureExternalIntegrationTables(pool);
  await ensureOperationalEventsTable(pool);
  await ensureVideoIntercomTypeCode(pool);
  await ensureAccessSecurityLocationSystemType(pool);
  await ensureAlertAccessDoorDeviceIds(pool);
  await ensureAlertSipRingLinkagesTable(pool);
  await ensureIsapiFaceContrastEventsTable(pool);
  const migratedSensorModels = await migrateLegacySensorModelConfigs(pool);
  const deviceModelSync = await syncDeviceModelCatalog(pool);
  const deviceModelRepair = await repairDeviceModelCatalogConfig(pool);
  logger.info("schema patches 已套用", {
    module: "schemaPatches",
    migratedSensorModels,
    ...deviceModelSync,
    ...deviceModelRepair,
  });
}

module.exports = {
  ALERT_SOURCE_ENUM_VALUES,
  ensureEnumValue,
  ensureAlertSourceEnumValues,
  ensureEnergyTables,
  ensureExternalIntegrationTables,
  ensureOperationalEventsTable,
  ensureVideoIntercomTypeCode,
  ensureAccessSecurityLocationSystemType,
  ensureAlertAccessDoorDeviceIds,
  ensureAlertSipRingLinkagesTable,
  ensureIsapiFaceContrastEventsTable,
  migrateLegacySensorModelConfigs,
  applySchemaPatches,
};
