const { Client: PgClient } = require("pg");
const mysql = require("mysql2/promise");
const mssql = require("mssql");
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { encryptSecret, decryptSecret } = require("../../utils/secretCrypto");
const {
  ACCESS_CONTROL_FIELD_CATALOG,
  getAccessControlFieldByKey,
  mapAccessControlEventToFieldValue,
  fetchAccessControlEventsAfterCursor,
} = require("./accessControlFields");

const EVENT_TYPE_ACCESS_CONTROL = "access_control";

function normalizeDbType(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "postgres" || v === "sqlserver" || v === "mysql") return v;
  return "";
}

function requireNonEmpty(value, name) {
  const v = String(value ?? "").trim();
  if (!v) {
    throwApiError(C.VALIDATION_CUSTOM, `${name} 為必填`, { statusCode: 400 });
  }
  return v;
}

function requirePort(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throwApiError(C.VALIDATION_CUSTOM, "Port 必須為 1–65535", {
      statusCode: 400,
    });
  }
  return Math.trunc(n);
}

function requirePushTime(value) {
  const v = String(value ?? "").trim();
  if (!/^\d{2}:\d{2}$/.test(v)) {
    throwApiError(C.VALIDATION_CUSTOM, "推播時間格式必須為 HH:mm", {
      statusCode: 400,
    });
  }
  return v;
}

function validateMappings(mappings) {
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throwApiError(C.VALIDATION_CUSTOM, "mappings 必須為物件", {
      statusCode: 400,
    });
  }

  for (const field of ACCESS_CONTROL_FIELD_CATALOG) {
    if (!field.required) continue;
    const cfg = mappings[field.key];
    if (!cfg || typeof cfg !== "object") {
      throwApiError(C.VALIDATION_CUSTOM, `${field.label} 欄位映射為必填`, {
        statusCode: 400,
      });
    }
    const targetColumn = String(cfg.targetColumn ?? "").trim();
    if (!targetColumn) {
      throwApiError(C.VALIDATION_CUSTOM, `${field.label} 的第三方欄位名為必填`, {
        statusCode: 400,
      });
    }
  }

  for (const [fieldKey, cfg] of Object.entries(mappings)) {
    const catalog = getAccessControlFieldByKey(fieldKey);
    if (!catalog) {
      throwApiError(C.VALIDATION_CUSTOM, `不支援的欄位: ${fieldKey}`, {
        statusCode: 400,
      });
    }
    if (cfg == null || typeof cfg !== "object") {
      throwApiError(C.VALIDATION_CUSTOM, `欄位 ${catalog.label} 映射格式不正確`, {
        statusCode: 400,
      });
    }
    const targetColumn = String(cfg.targetColumn ?? "").trim();
    if (!targetColumn) {
      throwApiError(
        C.VALIDATION_CUSTOM,
        `欄位「${catalog.label}」的第三方欄位名不可為空`,
        { statusCode: 400 },
      );
    }
    if (catalog.requiresFormat) {
      const fmt = String(cfg.format ?? "").trim();
      if (!fmt) {
        throwApiError(C.VALIDATION_CUSTOM, `欄位「${catalog.label}」必須設定格式`, {
          statusCode: 400,
        });
      }
    }
  }
}

async function connectExternalDb({ dbType, host, port, database, username, password }) {
  if (dbType === "postgres") {
    const client = new PgClient({
      host,
      port,
      database,
      user: username,
      password,
      connectionTimeoutMillis: 10000,
    });
    await client.connect();
    return { type: "postgres", client };
  }
  if (dbType === "mysql") {
    const conn = await mysql.createConnection({
      host,
      port,
      database,
      user: username,
      password,
      connectTimeout: 10000,
    });
    return { type: "mysql", client: conn };
  }
  if (dbType === "sqlserver") {
    const pool = new mssql.ConnectionPool({
      server: host,
      port,
      user: username,
      password,
      database,
      options: { encrypt: false, trustServerCertificate: true },
      connectionTimeout: 10000,
      requestTimeout: 20000,
    });
    await pool.connect();
    return { type: "sqlserver", client: pool };
  }
  const err = new Error(`不支援的 dbType: ${dbType}`);
  err.code = "UNSUPPORTED_DB_TYPE";
  throw err;
}

async function closeExternalDb(conn) {
  if (!conn) return;
  if (conn.type === "postgres") {
    await conn.client.end().catch(() => {});
    return;
  }
  if (conn.type === "mysql") {
    await conn.client.end().catch(() => {});
    return;
  }
  if (conn.type === "sqlserver") {
    await conn.client.close().catch(() => {});
  }
}

function buildInsertStatement(dbType, tableName, columns, rowCount) {
  if (dbType === "postgres") {
    const cols = columns.map((c) => `"${c.replaceAll("\"", "\"\"")}"`).join(", ");
    const values = [];
    let idx = 1;
    for (let r = 0; r < rowCount; r += 1) {
      const rowPlaceholders = columns.map(() => `$${idx++}`).join(", ");
      values.push(`(${rowPlaceholders})`);
    }
    return { sql: `INSERT INTO ${tableName} (${cols}) VALUES ${values.join(", ")}` };
  }
  if (dbType === "mysql") {
    const cols = columns.map((c) => `\`${c.replaceAll("`", "``")}\``).join(", ");
    const values = [];
    for (let r = 0; r < rowCount; r += 1) {
      const rowPlaceholders = columns.map(() => "?").join(", ");
      values.push(`(${rowPlaceholders})`);
    }
    return { sql: `INSERT INTO ${tableName} (${cols}) VALUES ${values.join(", ")}` };
  }
  if (dbType === "sqlserver") {
    const cols = columns.map((c) => `[${c.replaceAll("]", "]]")}]`).join(", ");
    const values = [];
    let idx = 1;
    for (let r = 0; r < rowCount; r += 1) {
      const rowPlaceholders = columns.map(() => `@p${idx++}`).join(", ");
      values.push(`(${rowPlaceholders})`);
    }
    return { sql: `INSERT INTO ${tableName} (${cols}) VALUES ${values.join(", ")}` };
  }
  throw new Error(`不支援的 dbType: ${dbType}`);
}

async function insertRows(conn, tableName, columns, rows) {
  if (!rows.length) return;
  const stmt = buildInsertStatement(conn.type, tableName, columns, rows.length);
  const flat = rows.flat();
  if (conn.type === "postgres") {
    await conn.client.query(stmt.sql, flat);
    return;
  }
  if (conn.type === "mysql") {
    await conn.client.query(stmt.sql, flat);
    return;
  }
  if (conn.type === "sqlserver") {
    const request = conn.client.request();
    flat.forEach((v, i) => request.input(`p${i + 1}`, v));
    await request.query(stmt.sql);
  }
}

async function testExternalDbConnection({ dbType, host, port, database, username, password }) {
  const conn = await connectExternalDb({ dbType, host, port, database, username, password });
  try {
    if (conn.type === "postgres") await conn.client.query("SELECT 1");
    else if (conn.type === "mysql") await conn.client.query("SELECT 1");
    else await conn.client.request().query("SELECT 1");
  } finally {
    await closeExternalDb(conn);
  }
}

async function getConfig() {
  const rows = await db.query(
    "SELECT * FROM external_sync_configs WHERE event_type = ? LIMIT 1",
    [EVENT_TYPE_ACCESS_CONTROL],
  );
  const config = rows?.[0] ?? null;
  if (!config) return null;

  const mapRows = await db.query(
    "SELECT field_key, target_column, format FROM external_sync_field_mappings WHERE config_id = ? ORDER BY id ASC",
    [config.id],
  );

  const mappings = {};
  for (const r of mapRows || []) {
    mappings[r.field_key] = {
      targetColumn: r.target_column,
      format: r.format ?? "",
    };
  }

  return {
    id: config.id,
    eventType: config.event_type,
    pushTime: String(config.push_time).slice(0, 5),
    dbType: config.db_type,
    host: config.host,
    port: config.port,
    database: config.database_name,
    username: config.username,
    password: "",
    targetTable: config.target_table,
    mappings,
    updatedAt: config.updated_at,
  };
}

async function upsertConfig(payload) {
  const dbType = normalizeDbType(payload.dbType);
  if (!dbType) {
    throwApiError(C.VALIDATION_CUSTOM, "資料庫類型不正確", { statusCode: 400 });
  }

  const pushTime = requirePushTime(payload.pushTime);
  const host = requireNonEmpty(payload.host, "伺服器 IP/網域");
  const port = requirePort(payload.port);
  const databaseName = requireNonEmpty(payload.database, "資料庫名稱");
  const username = requireNonEmpty(payload.username, "使用者名稱");
  const targetTable = requireNonEmpty(payload.targetTable, "第三方資料庫表格名稱");

  validateMappings(payload.mappings);

  const passwordEnc = encryptSecret(requireNonEmpty(payload.password, "密碼"));

  const saved = await db.transaction(async (q) => {
    const upsertRows = await q(
      `
        INSERT INTO external_sync_configs
          (event_type, push_time, db_type, host, port, database_name, username, password_enc, target_table)
        VALUES
          (?, ?::time, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (event_type) DO UPDATE
        SET push_time = EXCLUDED.push_time,
            db_type = EXCLUDED.db_type,
            host = EXCLUDED.host,
            port = EXCLUDED.port,
            database_name = EXCLUDED.database_name,
            username = EXCLUDED.username,
            password_enc = EXCLUDED.password_enc,
            target_table = EXCLUDED.target_table,
            updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `,
      [
        EVENT_TYPE_ACCESS_CONTROL,
        pushTime,
        dbType,
        host,
        port,
        databaseName,
        username,
        passwordEnc,
        targetTable,
      ],
    );
    const configId = upsertRows?.[0]?.id;
    if (!configId) {
      throwApiError(C.INTERNAL_ERROR, "儲存資料庫對接設定失敗", {
        statusCode: 500,
      });
    }

    await q("DELETE FROM external_sync_field_mappings WHERE config_id = ?", [configId]);

    for (const [fieldKey, cfg] of Object.entries(payload.mappings || {})) {
      await q(
        `
          INSERT INTO external_sync_field_mappings
            (config_id, field_key, target_column, format)
          VALUES
            (?, ?, ?, ?)
        `,
        [
          configId,
          fieldKey,
          String(cfg.targetColumn).trim(),
          cfg.format != null ? String(cfg.format).trim() : null,
        ],
      );
    }

    return { id: configId };
  });

  return saved;
}

async function loadConfigWithMappings() {
  const cfgRows = await db.query(
    "SELECT * FROM external_sync_configs WHERE event_type = 'access_control' LIMIT 1",
    [],
  );
  const cfg = cfgRows?.[0] ?? null;
  if (!cfg) return null;
  const mapRows = await db.query(
    "SELECT field_key, target_column, format FROM external_sync_field_mappings WHERE config_id = ? ORDER BY id ASC",
    [cfg.id],
  );
  const mappings = (mapRows || []).map((r) => ({
    fieldKey: r.field_key,
    targetColumn: r.target_column,
    format: r.format ?? "",
  }));
  return { cfg, mappings };
}

async function runExternalSyncOnce() {
  const loaded = await loadConfigWithMappings();
  if (!loaded) return { skipped: true };
  const { cfg, mappings } = loaded;

  const password = decryptSecret(cfg.password_enc);
  const logRows = await db.query(
    "INSERT INTO external_sync_run_logs (config_id, success, row_count) VALUES (?, FALSE, 0) RETURNING id",
    [cfg.id],
  );
  const logId = logRows?.[0]?.id ?? null;

  let conn = null;
  try {
    const { events: rawEvents, lastFetchedEventTime } = await fetchAccessControlEventsAfterCursor(
      cfg.cursor_ts,
      5000,
    );
    const events = rawEvents.filter((e) => e.employeeId);

    const columns = mappings.map((m) => m.targetColumn);
    const dataRows = events.map((evt) =>
      mappings.map((m) => mapAccessControlEventToFieldValue(evt, m.fieldKey, m)),
    );

    conn = await connectExternalDb({
      dbType: cfg.db_type,
      host: cfg.host,
      port: cfg.port,
      database: cfg.database_name,
      username: cfg.username,
      password,
    });
    await insertRows(conn, cfg.target_table, columns, dataRows);

    if (lastFetchedEventTime) {
      await db.query("UPDATE external_sync_configs SET cursor_ts = ? WHERE id = ?", [
        lastFetchedEventTime,
        cfg.id,
      ]);
    }

    if (logId) {
      await db.query(
        "UPDATE external_sync_run_logs SET finished_at = CURRENT_TIMESTAMP, success = TRUE, row_count = ?, error_message = NULL WHERE id = ?",
        [dataRows.length, logId],
      );
    }
    return { ok: true, rowCount: dataRows.length };
  } catch (err) {
    if (logId) {
      await db.query(
        "UPDATE external_sync_run_logs SET finished_at = CURRENT_TIMESTAMP, success = FALSE, error_message = ? WHERE id = ?",
        [err?.message || String(err), logId],
      );
    }
    throw err;
  } finally {
    await closeExternalDb(conn);
  }
}

module.exports = {
  getConfig,
  upsertConfig,
  runExternalSyncOnce,
  testExternalDbConnection,
};
