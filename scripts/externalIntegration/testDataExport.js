/**
 * 資料匯出本機測試 CLI（假第三方 DB + 立刻執行，略過排程）
 *
 *   npm run test:data-export              # 一鍵 all
 *   npm run test:data-export -- setup --apply-config
 *   npm run test:data-export -- seed [--count N]
 *   npm run test:data-export -- sync [--reset-cursor] [--verify]
 *   npm run test:data-export -- export --group-id <id> | --rule-id <id>
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

process.chdir(path.resolve(__dirname, "../.."));

const config = require("../../src/config");
const db = require("../../src/database/db");
const externalSyncService = require("../../src/services/externalIntegration/externalSyncService");
const recordExportService = require("../../src/services/externalIntegration/recordExportService");
const { decryptSecret } = require("../../src/utils/secretCrypto");

const DEFAULT_TABLE = "ba_export_test_access_events";
const GROUP_NAME = "BA_EXPORT_TEST_GROUP";
const EMPLOYEE_PREFIX = "BA_EXPORT_TEST_";
const TEST_RULE_NAME = "BA_EXPORT_TEST_RULE";
const DEFAULT_EXPORT_DIR = path.resolve(process.cwd(), "tmp", "record-export-test");

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

const printHelp = () => {
  console.log(`
用法: node scripts/externalIntegration/testDataExport.js <command> [options]

commands:
  all      一鍵：setup --apply-config → seed → sync --reset-cursor --verify → export
  setup    建立測試目標表 [--table NAME] [--apply-config]
  seed     種子人員／門禁事件 [--count N]
  sync     立刻資料庫對接 [--reset-cursor] [--verify]
  export   立刻記錄轉存 --group-id N | --rule-id N [--dir PATH]
`);
};

const DEFAULT_MAPPINGS = {
  employeeId: { targetColumn: "employee_id" },
  personName: { targetColumn: "person_name" },
  personGroup: { targetColumn: "person_group" },
  deviceName: { targetColumn: "device_name" },
  deviceScreenshot: { targetColumn: "device_screenshot" },
  eventDateTime: { targetColumn: "event_datetime", format: "yyyy-MM-dd HH:mm:ss" },
  eventDate: { targetColumn: "event_date", format: "yyyy-MM-dd" },
  eventTime: { targetColumn: "event_time", format: "HH:mm:ss" },
  cardNo: { targetColumn: "card_no" },
};

const cmdSetup = async (argv) => {
  const applyConfig = hasFlag(argv, "--apply-config");
  const table = takeFlag(argv, "--table") || DEFAULT_TABLE;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`表名不合法: ${table}`);
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
      id BIGSERIAL PRIMARY KEY,
      employee_id TEXT,
      person_name TEXT,
      person_group TEXT,
      device_name TEXT,
      device_screenshot TEXT,
      event_datetime TEXT,
      event_date TEXT,
      event_time TEXT,
      card_no TEXT,
      pushed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${table}_pushed_at`)}
     ON ${quoteIdent(table)} (pushed_at DESC)`,
  );
  console.log(`✓ 目標表 ${table} @ ${config.database.host}:${config.database.port}/${config.database.database}`);

  if (!applyConfig) return;

  await externalSyncService.upsertConfig({
    eventType: "access_control",
    pushTime: "23:59",
    dbType: "postgres",
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    username: config.database.user,
    password: config.database.password,
    targetTable: table,
    mappings: DEFAULT_MAPPINGS,
  });
  await db.query(
    `UPDATE external_sync_configs
     SET cursor_ts = NULL, cursor_event_id = NULL
     WHERE event_type = 'access_control'`,
  );
  console.log("✓ 已寫入對接設定（cursor 已清空）");
};

const cmdSeed = async (argv) => {
  const raw = takeFlag(argv, "--count");
  const n = Number(raw);
  const count = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 50) : 3;

  let groupId;
  const existingGroup = await db.query(
    "SELECT id FROM person_groups WHERE name = ? LIMIT 1",
    [GROUP_NAME],
  );
  if (existingGroup?.[0]?.id) {
    groupId = Number(existingGroup[0].id);
  } else {
    const rows = await db.query(
      "INSERT INTO person_groups (name) VALUES (?) RETURNING id",
      [GROUP_NAME],
    );
    groupId = Number(rows[0].id);
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
        [fullName, groupId, existing[0].id],
      );
    } else {
      await db.query(
        `INSERT INTO persons (employee_no, full_name, person_group_id, status)
         VALUES (?, ?, ?, 'active')`,
        [employeeNo, fullName, groupId],
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

  console.log(`✓ 群組 id=${groupId}；已種子 ${count} 人／事件（${EMPLOYEE_PREFIX}*）`);
  return groupId;
};

const cmdSync = async (argv) => {
  const resetCursor = hasFlag(argv, "--reset-cursor");
  const verify = hasFlag(argv, "--verify");

  const cfgRows = await db.query(
    `SELECT id, host, port, database_name, target_table, cursor_ts, cursor_event_id, password_enc, username
     FROM external_sync_configs WHERE event_type = 'access_control' LIMIT 1`,
  );
  const cfg = cfgRows?.[0];
  if (!cfg) {
    throw new Error("尚未設定對接。請先: npm run test:data-export -- setup --apply-config");
  }

  console.log(
    `設定: ${cfg.host}:${cfg.port}/${cfg.database_name} → ${cfg.target_table} (cursor=${cfg.cursor_ts || "null"}, eventId=${cfg.cursor_event_id ?? "null"})`,
  );

  if (resetCursor) {
    await db.query(
      "UPDATE external_sync_configs SET cursor_ts = NULL, cursor_event_id = NULL WHERE id = ?",
      [cfg.id],
    );
    console.log("✓ 已清空 cursor");
  }

  const result = await externalSyncService.runExternalSyncOnce();
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
  const ruleIdArg = takeFlag(argv, "--rule-id");
  const groupIdArg = takeFlag(argv, "--group-id");
  const dir = takeFlag(argv, "--dir") || DEFAULT_EXPORT_DIR;

  let ruleId = Number(ruleIdArg);
  if (!Number.isFinite(ruleId) || ruleId <= 0) {
    const groupId = Number(groupIdArg);
    if (!Number.isFinite(groupId) || groupId <= 0) {
      throw new Error("請提供 --rule-id 或 --group-id");
    }
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      name: TEST_RULE_NAME,
      description: "腳本測試規則",
      filenamePrefix: "BaExportTest",
      dateFormat: "yyyyMMdd",
      timeFormat: "HHmmss",
      outputFormat: "csv",
      exportTime: "23:59",
      storageType: "local",
      localDir: dir,
      groupIds: [groupId],
      fields: [
        { fieldKey: "employeeId", headerLabel: "員工ID" },
        { fieldKey: "personName", headerLabel: "姓名" },
        { fieldKey: "personGroup", headerLabel: "群組" },
        { fieldKey: "deviceName", headerLabel: "出入口" },
        { fieldKey: "eventDateTime", headerLabel: "進出時間", format: "yyyy-MM-dd HH:mm:ss" },
        { fieldKey: "cardNo", headerLabel: "卡號" },
      ],
    };
    const existing = await db.query(
      "SELECT id FROM record_export_rules WHERE name = ? LIMIT 1",
      [TEST_RULE_NAME],
    );
    if (existing?.[0]?.id) {
      ruleId = Number(existing[0].id);
      await recordExportService.upsertRule(ruleId, payload);
    } else {
      const created = await recordExportService.upsertRule(null, payload);
      ruleId = Number(created.id);
    }
    console.log(`✓ 測試規則 id=${ruleId} → ${dir}`);
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

const cmdAll = async () => {
  console.log("=== 資料匯出一鍵測試 ===");
  await cmdSetup(["--apply-config"]);
  const groupId = await cmdSeed(["--count", "3"]);
  await cmdSync(["--reset-cursor", "--verify"]);
  await cmdExport(["--group-id", String(groupId)]);
  console.log(`
=== 完成 ===
目標表: ${DEFAULT_TABLE}
CSV:    ${DEFAULT_EXPORT_DIR}
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
