const archiveLabels = new Map([
  ["users", "username"], ["devices", "name"], ["device_models", "name"],
  ["persons", "full_name"], ["person_groups", "name"], ["zones", "name"], ["locations", "name"],
  ["location_systems", "system_type"], ["roll_call_rules", "name"], ["alert_rules", "name"],
  ["alert_linkages", "id"], ["system_settings", "key"], ["security_schedule_rules", "name"],
  ["lighting_schedule_rules", "name"], ["hvac_schedule_rules", "name"],
  ["external_sync_configs", "event_type"], ["record_export_rules", "name"],
]);
const archivedTables = [...archiveLabels.keys()];

const auditedTables = [
  ...archivedTables,
  "user_permission_overrides", "energy_settings", "alerts",
];
const auditedMappingTables = ["external_sync_field_mappings", "record_export_field_mappings"];
const preservedEventTables = [
  "alerts", "alert_events", "alert_linkage_executions", "operational_events", "people_counting_logs",
  "isapi_access_events", "isapi_people_counting_events", "isapi_face_contrast_events",
  "ladder_sdk_events", "vehicle_passageway_logs", "energy_readings",
  "environment_readings", "roll_call_sessions", "roll_call_attendance",
  "external_sync_run_logs", "record_export_run_logs",
];
const archiveMigration = "data_archive_v1";
const auditMigration = "management_audit_mappings_v3";
const parentConditions = {
  locations: "EXISTS (SELECT 1 FROM public.active_zones z WHERE z.id = locations.zone_id)",
  location_systems: "EXISTS (SELECT 1 FROM public.active_locations l WHERE l.id = location_systems.location_id)",
  alert_linkages: "EXISTS (SELECT 1 FROM public.active_alert_rules r WHERE r.id = alert_linkages.rule_id)",
  roll_call_rules: "EXISTS (SELECT 1 FROM public.active_location_systems ls WHERE ls.location_id = roll_call_rules.location_id AND ls.system_type = 'roll_call')",
};

const auditTriggerSql = `
  CREATE OR REPLACE FUNCTION public.record_management_change()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $audit$
  DECLARE
    before_row jsonb;
    after_row jsonb;
    event_action text := lower(TG_OP);
    actor text := nullif(current_setting('ba.actor_id', true), '');
    changed_fields text[];
    previous_fields jsonb;
    next_fields jsonb;
    ignored_fields text[] := ARRAY['updated_at'];
    safe_fields text[] := ARRAY[
      'status', 'role', 'enabled', 'archived_at', 'user_id', 'permission_id',
      'granted', 'zone_id', 'location_id', 'type_code', 'system_type', 'key',
      'sort_order', 'person_group_id', 'config_id', 'rule_id', 'field_key'
    ];
  BEGIN
    IF TG_ARGV[0] = 'archive' AND TG_OP = 'UPDATE' THEN
      IF OLD.archived_at IS DISTINCT FROM NEW.archived_at THEN
        event_action := CASE WHEN NEW.archived_at IS NULL THEN 'restore' ELSE 'archive' END;
      END IF;
    END IF;
    IF actor IS NULL AND event_action NOT IN ('archive', 'restore') THEN RETURN NULL; END IF;

    IF TG_TABLE_NAME = 'users' THEN
      ignored_fields := ignored_fields || ARRAY['token_version'];
    ELSIF TG_TABLE_NAME = 'external_sync_configs' THEN
      ignored_fields := ignored_fields || ARRAY['cursor_ts', 'cursor_event_id'];
    END IF;
    before_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) - ignored_fields END;
    after_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) - ignored_fields END;
    IF TG_OP = 'UPDATE' AND before_row = after_row THEN RETURN NULL; END IF;

    SELECT array_agg(field ORDER BY field) FILTER (WHERE changed),
           coalesce(jsonb_object_agg(field, before_row->field)
             FILTER (WHERE field = ANY(safe_fields) AND before_row ? field), '{}'::jsonb),
           coalesce(jsonb_object_agg(field, after_row->field)
             FILTER (WHERE field = ANY(safe_fields) AND after_row ? field), '{}'::jsonb)
      INTO changed_fields, previous_fields, next_fields
      FROM (
        SELECT field, before_row->field IS DISTINCT FROM after_row->field AS changed
        FROM jsonb_object_keys(before_row || after_row) AS fields(field)
      ) AS field_changes
      WHERE changed OR field IN ('user_id', 'permission_id', 'key', 'config_id', 'rule_id', 'field_key');

    INSERT INTO public.management_audit_events
      (actor_id, actor_username, request_id, action, target_type, target_id, reason, details)
    VALUES (
      actor::integer, nullif(current_setting('ba.actor_username', true), ''),
      nullif(current_setting('ba.request_id', true), ''), event_action,
      TG_TABLE_NAME, coalesce(after_row->>'id', before_row->>'id', after_row->>'key', before_row->>'key'),
      nullif(current_setting('ba.reason', true), ''),
      jsonb_build_object('changed_fields', changed_fields, 'before', previous_fields, 'after', next_fields));
    RETURN NULL;
  END
  $audit$;
  REVOKE EXECUTE ON FUNCTION public.record_management_change() FROM PUBLIC;
`;

async function initializeArchiveSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.management_audit_events (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      actor_id INTEGER,
      actor_username TEXT,
      request_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      reason TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    REVOKE ALL ON public.management_audit_events FROM PUBLIC;
    CREATE INDEX IF NOT EXISTS idx_management_audit_target
      ON public.management_audit_events (target_type, target_id, id DESC);
    CREATE TABLE IF NOT EXISTS public.archived_person_revocations (
      person_id INTEGER PRIMARY KEY REFERENCES public.persons(id),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_archived_person_revocations_pending
      ON public.archived_person_revocations (next_attempt_at) WHERE completed_at IS NULL;
    CREATE OR REPLACE FUNCTION public.reject_history_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $protect$
    BEGIN
      RAISE EXCEPTION 'Physical deletion is disabled for %', TG_TABLE_NAME;
    END
    $protect$;
    DROP TRIGGER IF EXISTS protect_management_audit ON public.management_audit_events;
    CREATE TRIGGER protect_management_audit BEFORE UPDATE OR DELETE OR TRUNCATE
      ON public.management_audit_events FOR EACH STATEMENT
      EXECUTE FUNCTION public.reject_history_mutation();
  `);
  for (const table of archivedTables) {
    const parentCondition = parentConditions[table];
    await client.query(`
      ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
      CREATE OR REPLACE VIEW public.active_${table} AS
        SELECT public.${table}.* FROM public.${table}
        WHERE archived_at IS NULL ${parentCondition ? `AND ${parentCondition}` : ""}
        WITH LOCAL CHECK OPTION;
      CREATE INDEX IF NOT EXISTS idx_${table}_archived_id
        ON public.${table} (id DESC) WHERE archived_at IS NOT NULL;
      DROP TRIGGER IF EXISTS protect_archived_rows ON public.${table};
      CREATE TRIGGER protect_archived_rows BEFORE DELETE OR TRUNCATE
        ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION public.reject_history_mutation();
    `);
  }
  await client.query(`
    ALTER TABLE public.roll_call_attendance ADD COLUMN IF NOT EXISTS roster_removed_at TIMESTAMPTZ;
    CREATE OR REPLACE VIEW public.included_roll_call_attendance AS
      SELECT * FROM public.roll_call_attendance WHERE roster_removed_at IS NULL
      WITH LOCAL CHECK OPTION;
  `);
  for (const table of preservedEventTables) {
    await client.query(`
      DROP TRIGGER IF EXISTS protect_history_rows ON public.${table};
      CREATE TRIGGER protect_history_rows BEFORE DELETE OR TRUNCATE
        ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION public.reject_history_mutation();
    `);
  }
  await client.query(`
    ALTER TABLE public.location_systems DROP CONSTRAINT IF EXISTS location_systems_location_id_system_type_key;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_location_system
      ON public.location_systems (location_id, system_type) WHERE archived_at IS NULL;
    ALTER TABLE public.system_settings DROP CONSTRAINT IF EXISTS system_settings_key_key;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_setting
      ON public.system_settings (key) WHERE archived_at IS NULL;
    ALTER TABLE public.external_sync_configs DROP CONSTRAINT IF EXISTS external_sync_configs_event_type_key;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_external_sync
      ON public.external_sync_configs (event_type) WHERE archived_at IS NULL;
  `);
  for (const table of auditedTables) {
    await client.query(`
      DROP TRIGGER IF EXISTS audit_management_change ON public.${table};
      CREATE TRIGGER audit_management_change AFTER INSERT OR UPDATE OR DELETE
        ON public.${table} FOR EACH ROW
        EXECUTE FUNCTION public.record_management_change('${archivedTables.includes(table) ? "archive" : "change"}');
    `);
  }
  await client.query(`UPDATE public.roll_call_rules SET archived_at = clock_timestamp()
    WHERE location_id IS NULL AND archived_at IS NULL`);
  await client.query("INSERT INTO public.ba_schema_migrations (name) VALUES ($1)", [archiveMigration]);
}

async function ensureArchiveSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      SELECT pg_advisory_xact_lock(1763347101, 1);
      CREATE TABLE IF NOT EXISTS public.ba_schema_migrations (
        name TEXT PRIMARY KEY
      );
    `);
    const { rows } = await client.query(
      "SELECT name FROM public.ba_schema_migrations WHERE name = ANY($1::text[])",
      [[archiveMigration, auditMigration]],
    );
    const applied = new Set(rows.map(({ name }) => name));
    if (!applied.has(auditMigration)) await client.query(auditTriggerSql);
    if (!applied.has(archiveMigration)) await initializeArchiveSchema(client);
    if (!applied.has(auditMigration)) {
      for (const table of auditedMappingTables) {
        await client.query(`
          DROP TRIGGER IF EXISTS audit_management_change ON public.${table};
          CREATE TRIGGER audit_management_change AFTER INSERT OR UPDATE OR DELETE
            ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.record_management_change('change');
        `);
      }
      await client.query("INSERT INTO public.ba_schema_migrations (name) VALUES ($1)", [auditMigration]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertArchiveRuntimeAccess(pool) {
  const { rows: [access] } = await pool.query(`
    SELECT has_table_privilege(current_user, 'public.management_audit_events', 'SELECT') AS can_read,
           has_table_privilege(current_user, 'public.management_audit_events', 'INSERT') AS can_append,
           has_sequence_privilege(current_user, 'public.management_audit_events_id_seq', 'USAGE') AS can_use_sequence,
           (pg_has_role(current_user, c.relowner, 'MEMBER')
            OR has_table_privilege(current_user, c.oid, 'TRUNCATE, TRIGGER')
            OR EXISTS (
              SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0
                AND NOT a.attisdropped AND has_column_privilege(current_user, c.oid, a.attnum, 'UPDATE')
            )
            OR has_table_privilege(current_user, c.oid, 'DELETE')
            OR has_sequence_privilege(current_user, 'public.management_audit_events_id_seq', 'UPDATE')) AS can_change
    FROM pg_class c
    WHERE c.oid = 'public.management_audit_events'::regclass
      AND EXISTS (SELECT 1 FROM public.ba_schema_migrations WHERE name = $1)
  `, [auditMigration]);
  if (!access) throw new Error("封存 Schema 尚未升級，請先以遷移帳號執行 npm run db:migrate");
  if (!access.can_read || !access.can_append || !access.can_use_sequence || access.can_change) {
    throw new Error("執行角色需能讀取與新增稽核，且不得具備修改、刪除或管理稽核表的權限");
  }
}

module.exports = { archiveLabels, ensureArchiveSchema, assertArchiveRuntimeAccess };
