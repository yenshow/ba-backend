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
  "person_license_plates", "location_temporary_license_plates",
  "person_ladder_cards", "person_location_access", "person_elevator_floor_access",
  "roll_call_assignments", "roll_call_roster_dates",
  "alert_camera_linkages", "alert_access_door_linkages",
  "alert_sip_ring_linkages", "alert_elevator_call_linkages",
  "alert_email_subscriptions",
  "record_export_rule_groups",
  "pda_entrance_bindings", "garment_master", "garment_wash_limits",
  "multimedia_wall_seats",
];
const auditedMappingTables = [
  "external_sync_field_mappings", "record_export_field_mappings",
  "security_schedule_rule_locations", "lighting_schedule_rule_locations",
  "hvac_schedule_rule_locations",
];
const preservedEventTables = [
  "alerts", "alert_events", "alert_linkage_executions", "operational_events", "people_counting_logs",
  "isapi_access_events", "isapi_people_counting_events", "isapi_face_contrast_events",
  "ladder_sdk_events", "vehicle_passageway_logs", "energy_readings",
  "environment_readings", "roll_call_sessions", "roll_call_attendance",
  "external_sync_run_logs", "record_export_run_logs",
];

/** 現行遷移標記（舊名仍接受，避免重跑） */
const archiveMigration = "data_archive_v1";
const auditMigration = "management_audit_fields_v9";
const legacyAuditMigrations = [
  "management_audit_fields_v8",
  "management_audit_fields_v7",
  "management_audit_fields_v6",
  "management_audit_fields_v5",
  "management_audit_fields_v4",
  "management_audit_mappings_v3",
  "management_audit_changes_v2",
];
const identityUniquenessMigration = "active_identity_uniqueness_v1";

const parentConditions = {
  locations: "EXISTS (SELECT 1 FROM public.active_zones z WHERE z.id = locations.zone_id)",
  location_systems: "EXISTS (SELECT 1 FROM public.active_locations l WHERE l.id = location_systems.location_id)",
  alert_linkages: "EXISTS (SELECT 1 FROM public.active_alert_rules r WHERE r.id = alert_linkages.rule_id)",
  roll_call_rules: "EXISTS (SELECT 1 FROM public.active_location_systems ls WHERE ls.location_id = roll_call_rules.location_id AND ls.system_type = 'roll_call')",
};

const identityIndexes = [
  ["users", "username", "uq_active_users_username", "(username)"],
  ["zones", "name", "uq_active_zones_name", "(name)"],
  ["locations", "zone_id", "uq_active_locations_zone_name", "(zone_id, name)"],
  ["persons", "employee_no", "uq_active_persons_employee_no", "(employee_no)"],
];

const auditTriggerSql = `
  CREATE OR REPLACE FUNCTION public.audit_json_summary(value jsonb)
  RETURNS jsonb LANGUAGE sql IMMUTABLE AS $summary$
    SELECT CASE
      WHEN value IS NULL THEN NULL
      WHEN jsonb_typeof(value) = 'object' THEN jsonb_build_object(
        'keys', coalesce((
          SELECT jsonb_agg(key ORDER BY key) FROM jsonb_object_keys(value) AS keys(key)
        ), '[]'::jsonb),
        'sha256', encode(sha256(convert_to(value::text, 'UTF8')), 'hex')
      )
      ELSE jsonb_build_object(
        'typeof', to_jsonb(jsonb_typeof(value)),
        'sha256', encode(sha256(convert_to(value::text, 'UTF8')), 'hex')
      )
    END
  $summary$;

  CREATE OR REPLACE FUNCTION public.record_management_change()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $audit$
  DECLARE
    before_row jsonb;
    after_row jsonb;
    event_action text := lower(TG_OP);
    actor text := nullif(current_setting('ba.actor_id', true), '');
    changed text[];
    previous_fields jsonb := '{}'::jsonb;
    next_fields jsonb := '{}'::jsonb;
    ignored text[] := ARRAY[
      'updated_at', 'created_at', 'password_hash', 'password_enc', 'card_password',
      'smtp_password', 'sftp_password_enc', 'seat_token_hash',
      'token_version', 'cursor_ts', 'cursor_event_id',
      'isapi_sync_status', 'isapi_sync_error', 'isapi_synced_at',
      'sdk_sync_status', 'sdk_sync_error', 'sdk_synced_at',
      'wash_count', 'last_wash_date', 'last_seen_at', 'registered_at'
    ];
    tracked text[] := ARRAY[
      'status', 'role', 'enabled', 'archived_at',
      'name', 'username', 'full_name', 'employee_no', 'description', 'location', 'sort_order',
      'zone_id', 'location_id', 'type_code', 'system_type', 'key', 'event_type', 'value',
      'model_id', 'parent_id', 'person_group_id', 'user_id', 'permission_id', 'person_id',
      'category_code', 'unit_id',
      'granted', 'config_id', 'rule_id', 'field_key', 'group_id', 'floor_index',
      'config', 'system_config', 'custom_fields', 'condition_config', 'options_json', 'floors', 'filter_json',
      'days_of_week', 'window_start', 'window_end', 'on_time', 'off_time',
      'plate_number', 'plate_normalized', 'list_type', 'effective_begin', 'effective_end', 'display_name',
      'card_no', 'home_floor', 'card_type', 'floor_mode', 'valid_enabled', 'valid_begin', 'valid_end',
      'assignment_date', 'roster_date',
      'source', 'alert_type', 'severity', 'dimension_key', 'target_type', 'target_id',
      'condition_type', 'message_template_key', 'message_template', 'message_suffix', 'message_template_custom',
      'do_device_id', 'do_address', 'do_output_value', 'auto_off_seconds',
      'camera_device_ids', 'nvr_track_ids', 'device_ids', 'location_ids',
      'smtp_host', 'smtp_port', 'smtp_user', 'smtp_security', 'to_emails',
      'repeat_min_interval_seconds', 'repeat_max_send_count',
      'push_mode', 'db_type', 'host', 'port', 'database_name', 'target_table',
      'filename_prefix', 'output_format', 'export_time', 'schedule_freq', 'schedule_day',
      'date_format', 'time_format', 'column_delimiter', 'header_label',
      'storage_type', 'local_dir', 'sftp_host', 'sftp_port', 'sftp_username', 'sftp_remote_dir',
      'device_code', 'entrance_label', 'barcode', 'employee_name', 'department',
      'plant_code', 'garment_type', 'wash_limit', 'fingerprint', 'hostname'
    ];
    summary text[] := ARRAY[
      'config', 'system_config', 'custom_fields', 'condition_config',
      'options_json', 'floors', 'filter_json', 'value'
    ];
    field text;
    before_value jsonb;
    after_value jsonb;
    target_id text;
  BEGIN
    IF TG_ARGV[0] = 'archive' AND TG_OP = 'UPDATE' THEN
      IF OLD.archived_at IS DISTINCT FROM NEW.archived_at THEN
        event_action := CASE WHEN NEW.archived_at IS NULL THEN 'restore' ELSE 'archive' END;
      END IF;
    END IF;
    IF actor IS NULL AND event_action NOT IN ('archive', 'restore') THEN
      RETURN NULL;
    END IF;

    before_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) - ignored END;
    after_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) - ignored END;
    IF TG_OP = 'UPDATE' AND before_row = after_row THEN
      RETURN NULL;
    END IF;

    SELECT array_agg(diff.field ORDER BY diff.field)
      INTO changed
      FROM (
        SELECT key AS field
        FROM jsonb_object_keys(before_row || after_row) AS keys(key)
        WHERE before_row->key IS DISTINCT FROM after_row->key
          AND key = ANY(tracked)
      ) AS diff;

    IF TG_OP = 'UPDATE'
       AND event_action NOT IN ('archive', 'restore')
       AND changed IS NULL THEN
      RETURN NULL;
    END IF;

    FOREACH field IN ARRAY coalesce(changed, ARRAY[]::text[])
    LOOP
      IF field = ANY(summary) THEN
        before_value := CASE WHEN before_row ? field THEN public.audit_json_summary(before_row->field) END;
        after_value := CASE WHEN after_row ? field THEN public.audit_json_summary(after_row->field) END;
      ELSE
        before_value := before_row->field;
        after_value := after_row->field;
      END IF;
      IF before_row ? field THEN
        previous_fields := previous_fields || jsonb_build_object(field, before_value);
      END IF;
      IF after_row ? field THEN
        next_fields := next_fields || jsonb_build_object(field, after_value);
      END IF;
    END LOOP;

    target_id := coalesce(
      after_row->>'id', before_row->>'id',
      after_row->>'key', before_row->>'key',
      after_row->>'fingerprint', before_row->>'fingerprint',
      after_row->>'device_code', before_row->>'device_code',
      after_row->>'barcode', before_row->>'barcode'
    );
    IF target_id IS NULL
       AND (before_row ? 'rule_id' OR after_row ? 'rule_id')
       AND (before_row ? 'location_id' OR after_row ? 'location_id') THEN
      target_id := coalesce(after_row->>'rule_id', before_row->>'rule_id')
        || ':' || coalesce(after_row->>'location_id', before_row->>'location_id');
    ELSIF target_id IS NULL
       AND (before_row ? 'rule_id' OR after_row ? 'rule_id')
       AND (before_row ? 'group_id' OR after_row ? 'group_id') THEN
      target_id := coalesce(after_row->>'rule_id', before_row->>'rule_id')
        || ':' || coalesce(after_row->>'group_id', before_row->>'group_id');
    ELSIF target_id IS NULL
       AND (before_row ? 'location_id' OR after_row ? 'location_id')
       AND (before_row ? 'roster_date' OR after_row ? 'roster_date') THEN
      target_id := coalesce(after_row->>'location_id', before_row->>'location_id')
        || ':' || coalesce(after_row->>'roster_date', before_row->>'roster_date');
    ELSIF target_id IS NULL
       AND (before_row ? 'location_id' OR after_row ? 'location_id')
       AND (before_row ? 'plant_code' OR after_row ? 'plant_code')
       AND (before_row ? 'garment_type' OR after_row ? 'garment_type') THEN
      target_id := coalesce(after_row->>'location_id', before_row->>'location_id')
        || ':' || coalesce(after_row->>'plant_code', before_row->>'plant_code')
        || ':' || coalesce(after_row->>'garment_type', before_row->>'garment_type');
    END IF;

    INSERT INTO public.management_audit_events
      (actor_id, actor_username, request_id, action, target_type, target_id, reason, details)
    VALUES (
      actor::integer,
      nullif(current_setting('ba.actor_username', true), ''),
      nullif(current_setting('ba.request_id', true), ''),
      event_action,
      TG_TABLE_NAME,
      target_id,
      nullif(current_setting('ba.reason', true), ''),
      jsonb_strip_nulls(jsonb_build_object(
        'changed_fields', to_jsonb(changed),
        'before', previous_fields,
        'after', next_fields
      ))
    );
    RETURN NULL;
  END
  $audit$;

  REVOKE EXECUTE ON FUNCTION public.record_management_change() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.audit_json_summary(jsonb) FROM PUBLIC;
`;

async function dropUniqueConstraints(client, table, columnHint) {
  const { rows } = await client.query(
    `
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = $1
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) ILIKE '%' || $2 || '%'
    `,
    [table, columnHint],
  );
  for (const { conname } of rows) {
    await client.query(
      `ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS "${String(conname).replace(/"/g, '""')}"`,
    );
  }
}

async function applyActiveIdentityUniqueness(client) {
  for (const [table, hint, indexName, columns] of identityIndexes) {
    await dropUniqueConstraints(client, table, hint);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}
        ON public.${table} ${columns} WHERE archived_at IS NULL
    `);
  }
  await client.query(`DROP INDEX IF EXISTS public.uq_device_models_type_name`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_device_models_type_name
      ON public.device_models (type_code, name) WHERE archived_at IS NULL
  `);
}

async function remountAuditTriggers(client) {
  const tables = [
    ...auditedTables.map((table) => [table, archivedTables.includes(table) ? "archive" : "change"]),
    ...auditedMappingTables.map((table) => [table, "change"]),
  ];
  for (const [table, mode] of tables) {
    await client.query(`
      DROP TRIGGER IF EXISTS audit_management_change ON public.${table};
      CREATE TRIGGER audit_management_change AFTER INSERT OR UPDATE OR DELETE
        ON public.${table} FOR EACH ROW
        EXECUTE FUNCTION public.record_management_change('${mode}');
    `);
  }
}

async function markMigration(client, name) {
  await client.query(
    "INSERT INTO public.ba_schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
    [name],
  );
}

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

  await applyActiveIdentityUniqueness(client);
  await remountAuditTriggers(client);
  await client.query(`
    UPDATE public.roll_call_rules SET archived_at = clock_timestamp()
    WHERE location_id IS NULL AND archived_at IS NULL
  `);
  await markMigration(client, archiveMigration);
  await markMigration(client, identityUniquenessMigration);
  await markMigration(client, auditMigration);
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
      [[
        archiveMigration,
        auditMigration,
        identityUniquenessMigration,
        ...legacyAuditMigrations,
      ]],
    );
    const applied = new Set(rows.map(({ name }) => name));
    const hasCurrentAudit = applied.has(auditMigration);

    if (!applied.has(archiveMigration)) {
      await client.query(auditTriggerSql);
      await initializeArchiveSchema(client);
    } else {
      if (!applied.has(identityUniquenessMigration)) {
        await applyActiveIdentityUniqueness(client);
        await markMigration(client, identityUniquenessMigration);
      }
      if (!hasCurrentAudit) {
        await client.query(auditTriggerSql);
        await remountAuditTriggers(client);
        await markMigration(client, auditMigration);
      }
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
      AND EXISTS (
        SELECT 1 FROM public.ba_schema_migrations
        WHERE name = ANY($1::text[])
      )
  `, [[auditMigration, ...legacyAuditMigrations]]);
  if (!access) throw new Error("封存 Schema 尚未升級，請先以遷移帳號執行 npm run db:migrate");
  if (!access.can_read || !access.can_append || !access.can_use_sequence || access.can_change) {
    throw new Error("執行角色需能讀取與新增稽核，且不得具備修改、刪除或管理稽核表的權限");
  }
}

function getManagementAuditCoverage() {
  return {
    auditMigration,
    archivedTables: [...archivedTables],
    auditedTables: [...auditedTables],
    auditedMappingTables: [...auditedMappingTables],
    preservedEventTables: [...preservedEventTables],
    allTriggerTables: [...auditedTables, ...auditedMappingTables],
  };
}

module.exports = {
  archiveLabels,
  ensureArchiveSchema,
  assertArchiveRuntimeAccess,
  getManagementAuditCoverage,
};
