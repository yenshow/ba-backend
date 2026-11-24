/**
 * AUDIT-01：管理操作稽核覆蓋完整性（靜態＋可選 DB 觸發器檢查）
 *
 *   node tests/security/managementAuditCoverage.test.js
 *   npm run test:security:management-audit-coverage
 *
 * 靜態：initSchema 全部資料表必須歸類為「應稽核」或「刻意排除」，且應稽核表皆在 coverage。
 * DB（有連線時）：確認 v9 migration、每張應稽核表皆有 audit_management_change trigger，
 *   並以 system_settings.value 摘要寫入做一次行為煙測。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getManagementAuditCoverage,
  ensureArchiveSchema,
} = require("../../src/database/archiveSchema");

const INIT_SCHEMA_PATH = path.join(__dirname, "../../src/database/initSchema.js");
const EXPORT_PS1 = path.join(__dirname, "../../../scripts/export-management-audit.ps1");

/** 時序／執行狀態／種子：刻意不進 management_audit_events */
const INTENTIONAL_EXCLUSIONS = new Set([
  "permission_definitions",
  "people_counting_logs",
  "isapi_people_counting_events",
  "isapi_face_contrast_events",
  "vehicle_passageway_logs",
  "vehicle_access_reset_log",
  "people_counting_reset_log",
  "error_tracking",
  "alert_events",
  "operational_events",
  "alert_linkage_executions",
  "alert_email_send_state",
  "alert_email_rule_throttle",
  "person_device_sync_states",
  "person_sync_jobs",
  "person_sync_job_items",
  "person_sync_job_warnings",
  "isapi_access_events",
  "ladder_sdk_events",
  "environment_readings",
  "environment_readings_aggregated",
  "energy_readings",
  "energy_usage_aggregated",
  "external_sync_run_logs",
  "record_export_run_logs",
  "pda_scan_events",
  "roll_call_sessions",
  "roll_call_attendance",
]);

/** 各業務系統地點設定皆經 location_systems.system_type */
const LOCATION_SYSTEM_TYPES = [
  "environment",
  "lighting",
  "hvac",
  "air_circulation",
  "people_counting",
  "roll_call",
  "vehicle_access",
  "drainage",
  "power",
  "fire",
  "emergency_rescue",
  "smoke_alarm",
  "elevator",
  "intercom",
  "security",
];

const REQUIRED_TRACKED_FIELDS = [
  "value",
  "system_config",
  "days_of_week",
  "window_start",
  "on_time",
  "plate_number",
  "camera_device_ids",
  "device_ids",
  "location_ids",
  "smtp_host",
  "floor_index",
  "filter_json",
  "fingerprint",
];

const REQUIRED_IGNORED_FIELDS = [
  "password_hash",
  "password_enc",
  "card_password",
  "smtp_password",
  "sftp_password_enc",
  "seat_token_hash",
];

function listInitSchemaTables() {
  const src = fs.readFileSync(INIT_SCHEMA_PATH, "utf8");
  const tables = [];
  const re = /CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi;
  let match;
  while ((match = re.exec(src))) {
    tables.push(match[1]);
  }
  return [...new Set(tables)].sort();
}

function extractTriggerArray(kind) {
  const src = fs.readFileSync(
    path.join(__dirname, "../../src/database/archiveSchema.js"),
    "utf8",
  );
  const marker =
    kind === "tracked"
      ? /tracked text\[] := ARRAY\[([\s\S]*?)\];/
      : /ignored text\[] := ARRAY\[([\s\S]*?)\];/;
  const block = src.match(marker);
  assert.ok(block, `找不到 ${kind} 陣列`);
  return [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

async function runStaticChecks() {
  const coverage = getManagementAuditCoverage();
  assert.equal(coverage.auditMigration, "management_audit_fields_v9");
  assert.ok(coverage.auditedTables.includes("location_systems"));
  assert.ok(coverage.auditedTables.includes("system_settings"));
  assert.ok(coverage.auditedTables.includes("alert_camera_linkages"));
  assert.ok(coverage.auditedTables.includes("person_location_access"));
  assert.ok(coverage.auditedTables.includes("person_elevator_floor_access"));
  assert.ok(coverage.auditedMappingTables.includes("security_schedule_rule_locations"));

  const triggerSet = new Set(coverage.allTriggerTables);
  const initTables = listInitSchemaTables();
  assert.ok(initTables.length >= 50, `initSchema 表過少：${initTables.length}`);

  const unclassified = [];
  for (const table of initTables) {
    const audited = triggerSet.has(table);
    const excluded = INTENTIONAL_EXCLUSIONS.has(table);
    if (audited && excluded) {
      throw new Error(`${table} 同時出現在稽核與排除清單`);
    }
    if (!audited && !excluded) {
      unclassified.push(table);
    }
  }
  assert.deepEqual(
    unclassified,
    [],
    `以下資料表未歸類（應稽核或刻意排除）：${unclassified.join(", ")}`,
  );

  for (const table of coverage.allTriggerTables) {
    assert.ok(
      initTables.includes(table),
      `稽核表 ${table} 不存在於 initSchema`,
    );
  }

  const initSrc = fs.readFileSync(INIT_SCHEMA_PATH, "utf8");
  for (const systemType of LOCATION_SYSTEM_TYPES) {
    assert.match(
      initSrc,
      new RegExp(`'${systemType}'`),
      `location_systems 缺少 system_type=${systemType}`,
    );
  }

  const tracked = extractTriggerArray("tracked");
  const ignored = extractTriggerArray("ignored");
  for (const field of REQUIRED_TRACKED_FIELDS) {
    assert.ok(tracked.includes(field), `tracked 缺少 ${field}`);
  }
  for (const field of REQUIRED_IGNORED_FIELDS) {
    assert.ok(ignored.includes(field), `ignored 缺少 ${field}`);
  }
  assert.ok(fs.existsSync(EXPORT_PS1), "缺少 export-management-audit.ps1");
  const ps1 = fs.readFileSync(EXPORT_PS1, "utf8");
  assert.match(ps1, /data-archive\/audit/);
  assert.match(ps1, /操作者帳號/);
  assert.match(ps1, /地點系統設定/);
  assert.doesNotMatch(ps1, /IncludeAll|-Type\b|Write-AuditXlsx|jsonl/);

  console.log(
    `static OK: initTables=${initTables.length}, auditedTriggers=${coverage.allTriggerTables.length}, exclusions=${INTENTIONAL_EXCLUSIONS.size}`,
  );
  return coverage;
}

async function runDbChecks(coverage) {
  let db;
  try {
    db = require("../../src/database/db");
    await db.testConnection();
  } catch (error) {
    console.log(`db SKIP: ${error.message || error}`);
    return;
  }

  const { pool } = db;
  await ensureArchiveSchema(pool);
  const { rows: migrations } = await pool.query(
    "SELECT name FROM ba_schema_migrations WHERE name = $1",
    [coverage.auditMigration],
  );
  assert.equal(migrations.length, 1, `缺少 migration ${coverage.auditMigration}`);

  const { rows: triggers } = await pool.query(`
    SELECT c.relname AS table_name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND t.tgname = 'audit_management_change'
    ORDER BY c.relname
  `);
  const present = new Set(triggers.map((r) => r.table_name));
  const missing = coverage.allTriggerTables.filter((t) => !present.has(t));
  assert.deepEqual(missing, [], `DB 缺少 audit trigger：${missing.join(", ")}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      SELECT set_config('ba.actor_id', '1', true),
             set_config('ba.actor_username', 'audit-coverage-test', true),
             set_config('ba.request_id', 'audit-coverage-req', true),
             set_config('ba.reason', 'coverage-smoke', true)
    `);
    await client.query(`
      INSERT INTO system_settings (key, value, description)
      VALUES ('__audit_coverage_probe__', 'before-value', 'probe')
      ON CONFLICT (key) WHERE archived_at IS NULL
      DO UPDATE SET value = EXCLUDED.value, archived_at = NULL
    `);
    await client.query(`
      UPDATE system_settings
      SET value = 'after-value-' || floor(extract(epoch from now()))::text
      WHERE key = '__audit_coverage_probe__' AND archived_at IS NULL
    `);
    const { rows } = await client.query(`
      SELECT action, target_type, target_id, details
      FROM management_audit_events
      WHERE actor_username = 'audit-coverage-test'
        AND target_type = 'system_settings'
      ORDER BY id DESC
      LIMIT 10
    `);
    assert.ok(rows.length >= 1, "system_settings 異動應寫入稽核");
    const hit = rows.find(
      (row) =>
        row.action === "update" &&
        Array.isArray(row.details?.changed_fields) &&
        row.details.changed_fields.includes("value"),
    );
    assert.ok(hit, "更新 value 應出現在 changed_fields");
    assert.equal(hit.details?.after?.value?.typeof, "string");
    assert.ok(hit.details?.after?.value?.sha256, "value 應為 sha256 摘要");

    // 各業務系統地點設定 SSOT：location_systems.system_config
    const { rows: zones } = await client.query(`
      INSERT INTO zones (name) VALUES ('__audit_zone_probe__')
      RETURNING id
    `);
    const zoneId = zones[0].id;
    const { rows: locs } = await client.query(`
      INSERT INTO locations (zone_id, name) VALUES ($1, '__audit_loc_probe__')
      RETURNING id
    `, [zoneId]);
    const locationId = locs[0].id;
    const { rows: systems } = await client.query(`
      INSERT INTO location_systems (location_id, system_type, system_config)
      VALUES ($1, 'security', '{"arming_mode":"immediate"}'::jsonb)
      RETURNING id
    `, [locationId]);
    await client.query(`
      UPDATE location_systems
      SET system_config = '{"arming_mode":"delay","arming_delay_seconds":30}'::jsonb
      WHERE id = $1
    `, [systems[0].id]);
    const { rows: lsAudit } = await client.query(`
      SELECT action, details
      FROM management_audit_events
      WHERE actor_username = 'audit-coverage-test'
        AND target_type = 'location_systems'
        AND target_id = $1::text
      ORDER BY id DESC
      LIMIT 5
    `, [String(systems[0].id)]);
    const lsHit = lsAudit.find(
      (row) =>
        row.action === "update" &&
        Array.isArray(row.details?.changed_fields) &&
        row.details.changed_fields.includes("system_config"),
    );
    assert.ok(lsHit, "location_systems.system_config 更新應寫入稽核");
    assert.ok(lsHit.details?.after?.system_config?.sha256, "system_config 應為摘要");

    await client.query(`
      UPDATE system_settings
      SET archived_at = clock_timestamp()
      WHERE key = '__audit_coverage_probe__'
    `);
    await client.query(`
      UPDATE location_systems SET archived_at = clock_timestamp() WHERE id = $1
    `, [systems[0].id]);
    await client.query(`
      UPDATE locations SET archived_at = clock_timestamp() WHERE id = $1
    `, [locationId]);
    await client.query(`
      UPDATE zones SET archived_at = clock_timestamp() WHERE id = $1
    `, [zoneId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  console.log(
    `db OK: migration=${coverage.auditMigration}, triggers=${present.size}, smoke=settings+location_systems`,
  );

  await db.close().catch(() => {});
}

const run = async () => {
  const coverage = await runStaticChecks();
  await runDbChecks(coverage);
  console.log("managementAuditCoverage: all checks passed");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
