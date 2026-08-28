/**
 * 資料匯出本機測試 CLI（假第三方 DB + 立刻對接，略過排程）
 *
 *   npm run test:data-export              # 一鍵：門禁 + energy/operational 對接煙測
 *   npm run test:data-export -- setup --apply-config [--event-type TYPE]
 *   npm run test:data-export -- seed [--count N] [--event-type TYPE]
 *   npm run test:data-export -- sync [--reset-cursor] [--verify] [--event-type TYPE]
 *   npm run test:data-export -- export --group-id <id> | --rule-id <id> [--event-type TYPE]
 *
 * 看欄位／CSV：npm run test:data-export:sample-all → tmp/data-export/
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("pg");

process.chdir(path.resolve(__dirname, "../.."));

const config = require("../../src/config");
const db = require("../../src/database/db");
const externalSyncService = require("../../src/services/externalIntegration/externalSyncService");
const recordExportService = require("../../src/services/externalIntegration/recordExportService");
const { decryptSecret } = require("../../src/utils/secretCrypto");

const DEFAULT_TABLE = {
  access_control: "ba_export_test_access_events",
  energy: "ba_export_test_energy_readings",
  operational: "ba_export_test_operational_events",
};
const GROUP_NAME = "BA_EXPORT_TEST_GROUP";
const EMPLOYEE_PREFIX = "BA_EXPORT_TEST_";
const TEST_RULE_NAME = {
  access_control: "BA_EXPORT_TEST_RULE",
  energy: "BA_EXPORT_TEST_RULE_ENERGY",
  operational: "BA_EXPORT_TEST_RULE_OPERATIONAL",
};
/** 手動 export 暫存目錄（不寫入 tmp/data-export） */
const DEFAULT_EXPORT_DIR = path.join(os.tmpdir(), "ba-export-smoke");

const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

const takeFlag = (argv, name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};

const hasFlag = (argv, name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};

const resolveEventType = (argv, fallback = "access_control") => {
  const raw = takeFlag(argv, "--event-type") || takeFlag(argv, "--eventType") || fallback;
  const v = String(raw || "").trim();
  if (!["access_control", "energy", "operational"].includes(v)) {
    throw new Error(`此腳本煙測僅支援 access_control|energy|operational，收到: ${v}`);
  }
  return v;
};

const printHelp = () => {
  console.log(`
用法: node scripts/externalIntegration/testDataExport.js <command> [options]

commands:
  all      一鍵：門禁 setup/seed/sync → energy／operational 對接煙測
  setup    建立測試目標表 [--table NAME] [--apply-config] [--event-type TYPE]
  seed     種子資料 [--count N] [--event-type TYPE]
  sync     立刻資料庫對接 [--reset-cursor] [--verify] [--event-type TYPE]
  export   立刻記錄轉存（選用；預設寫 OS temp）--group-id N | --rule-id N [--dir PATH] [--event-type TYPE]
`);
};

const MAPPINGS = {
  access_control: {
    employeeId: { targetColumn: "employee_id" },
    personName: { targetColumn: "person_name" },
    personGroup: { targetColumn: "person_group" },
    deviceId: { targetColumn: "device_id" },
    deviceName: { targetColumn: "device_name" },
    deviceScreenshot: { targetColumn: "device_screenshot" },
    eventDateTime: { targetColumn: "event_datetime", format: "yyyy-MM-dd HH:mm:ss" },
    eventDate: { targetColumn: "event_date", format: "yyyy-MM-dd" },
    eventTime: { targetColumn: "event_time", format: "HH:mm:ss" },
    cardNo: { targetColumn: "card_no" },
    blank1: { targetColumn: "blank_1" },
    blank2: { targetColumn: "blank_2" },
  },
  energy: {
    deviceId: { targetColumn: "device_id" },
    deviceName: { targetColumn: "device_name" },
    recordedAt: { targetColumn: "recorded_at", format: "yyyy-MM-dd HH:mm:ss" },
    recordedDate: { targetColumn: "recorded_date", format: "yyyy-MM-dd" },
    recordedTime: { targetColumn: "recorded_time", format: "HH:mm:ss" },
    dataJson: { targetColumn: "data_json" },
  },
  operational: {
    occurredAt: { targetColumn: "occurred_at", format: "yyyy-MM-dd HH:mm:ss" },
    occurredDate: { targetColumn: "occurred_date", format: "yyyy-MM-dd" },
    occurredTime: { targetColumn: "occurred_time", format: "HH:mm:ss" },
    source: { targetColumn: "source" },
    eventKind: { targetColumn: "event_kind" },
    summary: { targetColumn: "summary" },
    deviceName: { targetColumn: "device_name" },
  },
};

const CREATE_SQL = {
  access_control: (table) => `
    CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
      id BIGSERIAL PRIMARY KEY,
      employee_id TEXT,
      person_name TEXT,
      person_group TEXT,
      device_id TEXT,
      device_name TEXT,
      device_screenshot TEXT,
      event_datetime TEXT,
      event_date TEXT,
      event_time TEXT,
      card_no TEXT,
      blank_1 TEXT,
      blank_2 TEXT,
      pushed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  energy: (table) => `
    CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
      id BIGSERIAL PRIMARY KEY,
      device_id TEXT,
      device_name TEXT,
      recorded_at TEXT,
      recorded_date TEXT,
      recorded_time TEXT,
      data_json TEXT,
      pushed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  operational: (table) => `
    CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TEXT,
      occurred_date TEXT,
      occurred_time TEXT,
      source TEXT,
      event_kind TEXT,
      summary TEXT,
      device_name TEXT,
      pushed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
};

const EXPORT_FIELDS = {
  access_control: [
    { fieldKey: "employeeId", headerLabel: "員工ID" },
    { fieldKey: "personName", headerLabel: "姓名" },
    { fieldKey: "personGroup", headerLabel: "群組" },
    { fieldKey: "deviceName", headerLabel: "出入口" },
    { fieldKey: "eventDateTime", headerLabel: "進出時間", format: "yyyy-MM-dd HH:mm:ss" },
    { fieldKey: "cardNo", headerLabel: "卡號" },
  ],
  energy: [
    { fieldKey: "deviceId", headerLabel: "設備ID" },
    { fieldKey: "deviceName", headerLabel: "設備名稱" },
    { fieldKey: "recordedAt", headerLabel: "記錄時間", format: "yyyy-MM-dd HH:mm:ss" },
    { fieldKey: "dataJson", headerLabel: "讀數JSON" },
  ],
  operational: [
    { fieldKey: "occurredAt", headerLabel: "發生時間", format: "yyyy-MM-dd HH:mm:ss" },
    { fieldKey: "source", headerLabel: "來源" },
    { fieldKey: "eventKind", headerLabel: "事件類型" },
    { fieldKey: "summary", headerLabel: "摘要" },
  ],
};

const cmdSetup = async (argv) => {
  const applyConfig = hasFlag(argv, "--apply-config");
  const eventType = resolveEventType(argv);
  const table = takeFlag(argv, "--table") || DEFAULT_TABLE[eventType];
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`表名不合法: ${table}`);
  }

  // IF NOT EXISTS 不會補新欄位；煙測表可重建
  await db.query(`DROP TABLE IF EXISTS ${quoteIdent(table)} CASCADE`);
  await db.query(CREATE_SQL[eventType](table));
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${table}_pushed_at`)}
     ON ${quoteIdent(table)} (pushed_at DESC)`,
  );
  console.log(
    `✓ [${eventType}] 目標表 ${table} @ ${config.database.host}:${config.database.port}/${config.database.database}`,
  );

  if (!applyConfig) return;

  await externalSyncService.upsertConfig({
    eventType,
    pushTime: "23:59",
    dbType: "postgres",
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    username: config.database.user,
    password: config.database.password,
    targetTable: table,
    mappings: MAPPINGS[eventType],
    // 種子寫入 energy_readings（raw）；預設 hourly 會對接 0 列
    ...(eventType === "energy" ? { options: { grain: "raw" } } : {}),
  });
  await db.query(
    `UPDATE external_sync_configs
     SET cursor_ts = NULL, cursor_event_id = NULL
     WHERE event_type = ?`,
    [eventType],
  );
  console.log(`✓ [${eventType}] 已寫入對接設定（cursor 已清空）`);
};

const CHILD_GROUP_NAME = `${GROUP_NAME}_CHILD`;

const cmdSeedAccess = async (count) => {
  let mainGroupId;
  const existingGroup = await db.query(
    "SELECT id FROM person_groups WHERE name = ? AND parent_id IS NULL LIMIT 1",
    [GROUP_NAME],
  );
  if (existingGroup?.[0]?.id) {
    mainGroupId = Number(existingGroup[0].id);
  } else {
    const rows = await db.query(
      "INSERT INTO person_groups (name, parent_id) VALUES (?, NULL) RETURNING id",
      [GROUP_NAME],
    );
    mainGroupId = Number(rows[0].id);
  }

  // 人員只能歸屬子群組；勿把 person_group_id 直接掛在主群組
  let childGroupId;
  const existingChild = await db.query(
    "SELECT id FROM person_groups WHERE name = ? AND parent_id = ? LIMIT 1",
    [CHILD_GROUP_NAME, mainGroupId],
  );
  if (existingChild?.[0]?.id) {
    childGroupId = Number(existingChild[0].id);
  } else {
    const rows = await db.query(
      "INSERT INTO person_groups (name, parent_id) VALUES (?, ?) RETURNING id",
      [CHILD_GROUP_NAME, mainGroupId],
    );
    childGroupId = Number(rows[0].id);
  }

  for (let i = 1; i <= count; i += 1) {
    const employeeNo = `${EMPLOYEE_PREFIX}${String(i).padStart(3, "0")}`;
    const fullName = `匯出測試員 ${i}`;
    const existing = await db.query(
      "SELECT id FROM persons WHERE employee_no = ? LIMIT 1",
      [employeeNo],
    );
    if (existing?.[0]?.id) {
      await db.query(
        "UPDATE persons SET full_name = ?, person_group_id = ?, status = 'active' WHERE id = ?",
        [fullName, childGroupId, existing[0].id],
      );
    } else {
      await db.query(
        `INSERT INTO persons (employee_no, full_name, person_group_id, status)
         VALUES (?, ?, ?, 'active')`,
        [employeeNo, fullName, childGroupId],
      );
    }

    await db.query(
      `INSERT INTO isapi_access_events
         (device_ip, event_time, event_type, payload, file_count)
       VALUES ('127.0.0.1', CURRENT_TIMESTAMP, 'AccessControllerEvent', ?::jsonb, 0)`,
      [
        JSON.stringify({
          employeeNoString: employeeNo,
          employeeNo,
          personName: fullName,
          cardNo: `CARD${String(i).padStart(3, "0")}`,
          eventType: "AccessControllerEvent",
          subEventType: 75,
        }),
      ],
    );
  }

  console.log(
    `✓ [access_control] 主群組 id=${mainGroupId}／子群組 id=${childGroupId}；已種子 ${count} 人／事件`,
  );
  return { groupId: mainGroupId, childGroupId };
};

const cmdSeedEnergy = async (count) => {
  const devices = await db.query("SELECT id, name FROM devices ORDER BY id ASC LIMIT 1");
  const device = devices?.[0];
  if (!device?.id) {
    throw new Error("庫中無 devices，無法種子 energy_readings。請先建立至少一台設備。");
  }
  for (let i = 1; i <= count; i += 1) {
    await db.query(
      `INSERT INTO energy_readings (device_id, recorded_at, data)
       VALUES (?, CURRENT_TIMESTAMP, ?::jsonb)`,
      [
        device.id,
        JSON.stringify({
          kwh: 100 + i,
          source: "BA_EXPORT_TEST",
          seq: i,
        }),
      ],
    );
  }
  console.log(`✓ [energy] device_id=${device.id}；已種子 ${count} 筆 energy_readings`);
  return { deviceId: Number(device.id) };
};

const cmdSeedOperational = async (count) => {
  for (let i = 1; i <= count; i += 1) {
    await db.query(
      `INSERT INTO operational_events (
         created_at, source, event_kind, message, payload
       ) VALUES (
         CURRENT_TIMESTAMP, 'system', 'control_write', ?, ?::jsonb
       )`,
      [
        `BA_EXPORT_TEST operational #${i}`,
        JSON.stringify({ source: "BA_EXPORT_TEST", seq: i }),
      ],
    );
  }
  console.log(`✓ [operational] 已種子 ${count} 筆 operational_events`);
  return {};
};

const cmdSeed = async (argv) => {
  const eventType = resolveEventType(argv);
  const raw = takeFlag(argv, "--count");
  const n = Number(raw);
  const count = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 50) : 3;
  if (eventType === "energy") return cmdSeedEnergy(count);
  if (eventType === "operational") return cmdSeedOperational(count);
  return cmdSeedAccess(count);
};

const cmdSync = async (argv) => {
  const eventType = resolveEventType(argv);
  const resetCursor = hasFlag(argv, "--reset-cursor");
  const verify = hasFlag(argv, "--verify");

  const cfgRows = await db.query(
    `SELECT id, host, port, database_name, target_table, cursor_ts, cursor_event_id, password_enc, username
     FROM external_sync_configs WHERE event_type = ? LIMIT 1`,
    [eventType],
  );
  const cfg = cfgRows?.[0];
  if (!cfg) {
    throw new Error(
      `尚未設定對接（${eventType}）。請先: npm run test:data-export -- setup --apply-config --event-type ${eventType}`,
    );
  }

  console.log(
    `[${eventType}] ${cfg.host}:${cfg.port}/${cfg.database_name} → ${cfg.target_table} (cursor=${cfg.cursor_ts || "null"}, eventId=${cfg.cursor_event_id ?? "null"})`,
  );

  if (resetCursor) {
    await db.query(
      "UPDATE external_sync_configs SET cursor_ts = NULL, cursor_event_id = NULL WHERE id = ?",
      [cfg.id],
    );
    console.log("✓ 已清空 cursor");
  }

  const result = await externalSyncService.runExternalSyncOnce(eventType);
  console.log("結果:", result);

  if (!verify) return result;

  const logs = await db.query(
    `SELECT id, success, row_count, error_message, started_at
     FROM external_sync_run_logs WHERE config_id = ? ORDER BY id DESC LIMIT 3`,
    [cfg.id],
  );
  console.log("最近 run logs:");
  for (const l of logs || []) {
    console.log(
      `  #${l.id} success=${l.success} rows=${l.row_count} err=${l.error_message || "-"}`,
    );
  }

  const table = cfg.target_table;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    console.log(`略過目標表查詢: ${table}`);
    return result;
  }

  const password = decryptSecret(cfg.password_enc);
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password,
    database: cfg.database_name,
  });
  await client.connect();
  try {
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${quoteIdent(table)}`,
    );
    const sample = await client.query(
      `SELECT * FROM ${quoteIdent(table)} ORDER BY id DESC LIMIT 5`,
    );
    console.log(`目標表 ${table} 總列數: ${countRes.rows[0].n}`);
    console.log("最近 5 列:", sample.rows);
  } finally {
    await client.end();
  }
  return result;
};

const cmdExport = async (argv) => {
  const eventType = resolveEventType(argv);
  const ruleIdArg = takeFlag(argv, "--rule-id");
  const groupIdArg = takeFlag(argv, "--group-id");
  const dir = takeFlag(argv, "--dir") || path.join(DEFAULT_EXPORT_DIR, eventType);

  let ruleId = Number(ruleIdArg);
  if (!Number.isFinite(ruleId) || ruleId <= 0) {
    fs.mkdirSync(dir, { recursive: true });
    const ruleName = TEST_RULE_NAME[eventType];
    const filter =
      eventType === "access_control"
        ? (() => {
            const groupId = Number(groupIdArg);
            if (!Number.isFinite(groupId) || groupId <= 0) {
              throw new Error("門禁轉存請提供 --rule-id 或 --group-id");
            }
            return { groupIds: [groupId] };
          })()
        : eventType === "energy"
          ? { grain: "raw" }
          : {};

    const payload = {
      eventType,
      name: ruleName,
      filenamePrefix: `BaExportTest_${eventType}`,
      dateFormat: "yyyyMMdd",
      timeFormat: "HHmmss",
      outputFormat: "csv",
      exportTime: "23:59",
      storageType: "local",
      localDir: dir,
      filter,
      groupIds: Array.isArray(filter.groupIds) ? filter.groupIds : [],
      fields: EXPORT_FIELDS[eventType],
    };
    const existing = await db.query(
      "SELECT id FROM record_export_rules WHERE name = ? LIMIT 1",
      [ruleName],
    );
    if (existing?.[0]?.id) {
      ruleId = Number(existing[0].id);
      await recordExportService.upsertRule(ruleId, payload);
    } else {
      const created = await recordExportService.upsertRule(null, payload);
      ruleId = Number(created.id);
    }
    console.log(`✓ [${eventType}] 測試規則 id=${ruleId} → ${dir}`);
  }

  const result = await recordExportService.runRecordExportRule(ruleId);
  console.log("結果:", result);

  const logs = await db.query(
    `SELECT id, success, row_count, file_paths, error_message
     FROM record_export_run_logs WHERE rule_id = ? ORDER BY id DESC LIMIT 3`,
    [ruleId],
  );
  for (const l of logs || []) {
    console.log(
      `  #${l.id} success=${l.success} rows=${l.row_count} files=${JSON.stringify(l.file_paths)} err=${l.error_message || "-"}`,
    );
  }
  return result;
};

const smokeEventType = async (eventType) => {
  console.log(`\n=== 煙測 ${eventType} ===`);
  await cmdSetup(["--apply-config", "--event-type", eventType]);
  await cmdSeed(["--count", "2", "--event-type", eventType]);
  await cmdSync(["--reset-cursor", "--verify", "--event-type", eventType]);
};

const cmdAll = async () => {
  console.log("=== 資料庫對接一鍵測試 ===");
  await cmdSetup(["--apply-config", "--event-type", "access_control"]);
  await cmdSeed(["--count", "3", "--event-type", "access_control"]);
  await cmdSync(["--reset-cursor", "--verify", "--event-type", "access_control"]);

  try {
    await smokeEventType("energy");
  } catch (e) {
    console.warn(`⚠ energy 煙測略過／失敗: ${e?.message || e}`);
  }
  try {
    await smokeEventType("operational");
  } catch (e) {
    console.warn(`⚠ operational 煙測略過／失敗: ${e?.message || e}`);
  }

  console.log(`
=== 完成 ===
門禁目標表: ${DEFAULT_TABLE.access_control}
看 CSV／欄位: npm run test:data-export:sample-all → tmp/data-export/
`);
};

const main = async () => {
  const argv = process.argv.slice(2);
  const cmd = argv.shift() || "all";
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }

  if (cmd === "all") await cmdAll();
  else if (cmd === "setup") await cmdSetup(argv);
  else if (cmd === "seed") await cmdSeed(argv);
  else if (cmd === "sync") await cmdSync(argv);
  else if (cmd === "export") await cmdExport(argv);
  else {
    printHelp();
    throw new Error(`未知 command: ${cmd}`);
  }
};

main()
  .then(async () => {
    await db.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("失敗:", err?.message || err);
    try {
      await db.close();
    } catch (_e) {
      /* ignore */
    }
    process.exit(1);
  });
