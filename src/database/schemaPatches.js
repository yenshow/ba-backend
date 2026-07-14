/**
 * 既有資料庫 schema 增量修補（啟動時執行；新裝仍由 initSchema 建立完整 enum）。
 */
const logger = require("../utils/logger").createLogger("schemaPatches");

/** 與 initSchema `alert_source`、alertService.ALERT_SOURCES 對齊 */
const ALERT_SOURCE_ENUM_VALUES = [
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
  await pool.query(`
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
          'access', 'vehicle', 'elevator'
        ));
    END
    $do$;
  `);
}

async function applySchemaPatches(pool) {
  if (!pool) return;
  await ensureAlertSourceEnumValues(pool);
  await ensureExternalIntegrationTables(pool);
  await ensureOperationalEventsTable(pool);
  logger.info("schema patches 已套用", { module: "schemaPatches" });
}

module.exports = {
  ALERT_SOURCE_ENUM_VALUES,
  ensureEnumValue,
  ensureAlertSourceEnumValues,
  ensureExternalIntegrationTables,
  ensureOperationalEventsTable,
  applySchemaPatches,
};
