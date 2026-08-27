const { Client: PgClient } = require("pg");
const mysql = require("mysql2/promise");
const mssql = require("mssql");
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { encryptSecret, decryptSecret } = require("../../utils/secretCrypto");
const { getAdapter, requireEventType, listEventTypes } = require("./eventTypeRegistry");
const { normalizeOptionsGrain } = require("./eventAdapters");

function parseOptionsJson(rawOptions) {
  if (rawOptions != null && typeof rawOptions === "object" && !Array.isArray(rawOptions)) {
    return { ...rawOptions };
  }
  if (typeof rawOptions === "string" && rawOptions.trim()) {
    try {
      const parsed = JSON.parse(rawOptions);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_e) {
      /* ignore */
    }
  }
  return {};
}

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
    throwApiError(C.VALIDATION_CUSTOM, "Port 必須為 1–65535", { statusCode: 400 });
  }
  return Math.trunc(n);
}

function requirePushTime(value) {
  const v = String(value ?? "").trim();
  if (!/^\d{2}:\d{2}$/.test(v)) {
    throwApiError(C.VALIDATION_CUSTOM, "推播時間格式必須為 HH:mm", { statusCode: 400 });
  }
  return v;
}

function validateMappings(adapter, mappings) {
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throwApiError(C.VALIDATION_CUSTOM, "mappings 必須為物件", { statusCode: 400 });
  }

  for (const field of adapter.catalog) {
    if (!field.required) continue;
    const cfg = mappings[field.key];
    if (!cfg || typeof cfg !== "object") {
      throwApiError(C.VALIDATION_CUSTOM, `${field.label} 欄位映射為必填`, {
        statusCode: 400,
      });
    }
    if (!String(cfg.targetColumn ?? "").trim()) {
      throwApiError(C.VALIDATION_CUSTOM, `${field.label} 的第三方欄位名為必填`, {
        statusCode: 400,
      });
    }
  }

  for (const [fieldKey, cfg] of Object.entries(mappings)) {
    const catalog = adapter.getFieldByKey(fieldKey);
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
    if (!String(cfg.targetColumn ?? "").trim()) {
      throwApiError(
        C.VALIDATION_CUSTOM,
        `欄位「${catalog.label}」的第三方欄位名不可為空`,
        { statusCode: 400 },
      );
    }
    if (catalog.requiresFormat && !String(cfg.format ?? "").trim()) {
      throwApiError(C.VALIDATION_CUSTOM, `欄位「${catalog.label}」必須設定格式`, {
        statusCode: 400,
      });
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
  throw new Error(`不支援的 dbType: ${dbType}`);
}

async function closeExternalDb(conn) {
  if (!conn) return;
  if (conn.type === "postgres") await conn.client.end().catch(() => {});
  else if (conn.type === "mysql") await conn.client.end().catch(() => {});
  else if (conn.type === "sqlserver") await conn.client.close().catch(() => {});
}

function buildInsertStatement(dbType, tableName, columns, rowCount) {
  if (dbType === "postgres") {
    const cols = columns.map((c) => `"${c.replaceAll("\"", "\"\"")}"`).join(", ");
    const values = [];
    let idx = 1;
    for (let r = 0; r < rowCount; r += 1) {
      values.push(`(${columns.map(() => `$${idx++}`).join(", ")})`);
    }
    return { sql: `INSERT INTO ${tableName} (${cols}) VALUES ${values.join(", ")}` };
  }
  if (dbType === "mysql") {
    const cols = columns.map((c) => `\`${c.replaceAll("`", "``")}\``).join(", ");
    const values = [];
    for (let r = 0; r < rowCount; r += 1) {
      values.push(`(${columns.map(() => "?").join(", ")})`);
    }
    return { sql: `INSERT INTO ${tableName} (${cols}) VALUES ${values.join(", ")}` };
  }
  if (dbType === "sqlserver") {
    const cols = columns.map((c) => `[${c.replaceAll("]", "]]")}]`).join(", ");
    const values = [];
    let idx = 1;
    for (let r = 0; r < rowCount; r += 1) {
      values.push(`(${columns.map(() => `@p${idx++}`).join(", ")})`);
    }
    return { sql: `INSERT INTO ${tableName} (${cols}) VALUES ${values.join(", ")}` };
  }
  throw new Error(`不支援的 dbType: ${dbType}`);
}

async function insertRows(conn, tableName, columns, rows) {
  if (!rows.length) return;
  const stmt = buildInsertStatement(conn.type, tableName, columns, rows.length);
  const flat = rows.flat();
  if (conn.type === "postgres") await conn.client.query(stmt.sql, flat);
  else if (conn.type === "mysql") await conn.client.query(stmt.sql, flat);
  else {
    const request = conn.client.request();
    flat.forEach((v, i) => request.input(`p${i + 1}`, v));
    await request.query(stmt.sql);
  }
}

async function testExternalDbConnection(opts) {
  const conn = await connectExternalDb(opts);
  try {
    if (conn.type === "postgres") await conn.client.query("SELECT 1");
    else if (conn.type === "mysql") await conn.client.query("SELECT 1");
    else await conn.client.request().query("SELECT 1");
  } finally {
    await closeExternalDb(conn);
  }
}

function mapConfigRow(config, mapRows) {
  const mappings = {};
  for (const r of mapRows || []) {
    mappings[r.field_key] = {
      targetColumn: r.target_column,
      format: r.format ?? "",
    };
  }
  const options = parseOptionsJson(config.options_json);
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
    options,
    updatedAt: config.updated_at,
  };
}

async function getConfig(eventType = "access_control") {
  const type = requireEventType(eventType);
  const rows = await db.query(
    "SELECT * FROM external_sync_configs WHERE event_type = ? LIMIT 1",
    [type],
  );
  const config = rows?.[0] ?? null;
  if (!config) return null;
  const mapRows = await db.query(
    "SELECT field_key, target_column, format FROM external_sync_field_mappings WHERE config_id = ? ORDER BY id ASC",
    [config.id],
  );
  return mapConfigRow(config, mapRows);
}

async function listConfigs() {
  const rows = await db.query(
    "SELECT * FROM external_sync_configs ORDER BY event_type ASC",
  );
  if (!rows?.length) return [];
  const ids = rows.map((r) => r.id);
  const mapRows = await db.query(
    `SELECT config_id, field_key, target_column, format
     FROM external_sync_field_mappings WHERE config_id IN (${ids.map(() => "?").join(",")})
     ORDER BY config_id ASC, id ASC`,
    ids,
  );
  const byConfig = new Map();
  for (const r of mapRows || []) {
    if (!byConfig.has(r.config_id)) byConfig.set(r.config_id, []);
    byConfig.get(r.config_id).push(r);
  }
  return rows.map((cfg) => mapConfigRow(cfg, byConfig.get(cfg.id) || []));
}

async function upsertConfig(payload) {
  const eventType = requireEventType(payload.eventType);
  const adapter = getAdapter(eventType);
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
  validateMappings(adapter, payload.mappings);

  let optionsJson = normalizeOptionsGrain(
    adapter,
    parseOptionsJson(payload.options),
  );

  const existingRows = await db.query(
    "SELECT password_enc FROM external_sync_configs WHERE event_type = ? LIMIT 1",
    [eventType],
  );
  const passwordRaw = String(payload.password ?? "").trim();
  let passwordEnc;
  if (passwordRaw) {
    passwordEnc = encryptSecret(passwordRaw);
  } else if (existingRows?.[0]?.password_enc) {
    passwordEnc = existingRows[0].password_enc;
  } else {
    throwApiError(C.VALIDATION_CUSTOM, "密碼為必填", { statusCode: 400 });
  }

  return db.transaction(async (q) => {
    const upsertRows = await q(
      `
        INSERT INTO external_sync_configs
          (event_type, push_time, db_type, host, port, database_name, username, password_enc, target_table, options_json)
        VALUES
          (?, ?::time, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
        ON CONFLICT (event_type) DO UPDATE
        SET push_time = EXCLUDED.push_time,
            db_type = EXCLUDED.db_type,
            host = EXCLUDED.host,
            port = EXCLUDED.port,
            database_name = EXCLUDED.database_name,
            username = EXCLUDED.username,
            password_enc = EXCLUDED.password_enc,
            target_table = EXCLUDED.target_table,
            options_json = EXCLUDED.options_json,
            updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `,
      [
        eventType,
        pushTime,
        dbType,
        host,
        port,
        databaseName,
        username,
        passwordEnc,
        targetTable,
        JSON.stringify(optionsJson),
      ],
    );
    const configId = upsertRows?.[0]?.id;
    if (!configId) {
      throwApiError(C.INTERNAL_ERROR, "儲存資料庫對接設定失敗", { statusCode: 500 });
    }
    await q("DELETE FROM external_sync_field_mappings WHERE config_id = ?", [configId]);
    for (const [fieldKey, cfg] of Object.entries(payload.mappings || {})) {
      await q(
        `INSERT INTO external_sync_field_mappings (config_id, field_key, target_column, format)
         VALUES (?, ?, ?, ?)`,
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
}

async function loadConfigWithMappings(eventType) {
  const type = requireEventType(eventType);
  const cfgRows = await db.query(
    `SELECT *, cursor_ts::text AS cursor_ts_text
     FROM external_sync_configs WHERE event_type = ? LIMIT 1`,
    [type],
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
  return { cfg, mappings, adapter: getAdapter(type) };
}

async function runExternalSyncOnce(eventType = "access_control") {
  const loaded = await loadConfigWithMappings(eventType);
  if (!loaded) return { skipped: true, eventType };
  const { cfg, mappings, adapter } = loaded;

  const password = decryptSecret(cfg.password_enc);
  const logRows = await db.query(
    "INSERT INTO external_sync_run_logs (config_id, success, row_count) VALUES (?, FALSE, 0) RETURNING id",
    [cfg.id],
  );
  const logId = logRows?.[0]?.id ?? null;

  let conn = null;
  try {
    const options = parseOptionsJson(cfg.options_json);
    const {
      events: rawEvents,
      cursorEvent: adapterCursorEvent,
    } = await adapter.fetchForSync({
      cursorTsText: cfg.cursor_ts_text,
      cursorEventId: cfg.cursor_event_id,
      limit: 5000,
      options,
    });
    const events =
      adapter.eventType === "access_control"
        ? rawEvents.filter((e) => e.employeeId)
        : rawEvents;

    const columns = mappings.map((m) => m.targetColumn);
    const dataRows = events.map((evt) =>
      mappings.map((m) => adapter.mapValue(evt, m.fieldKey, m)),
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

    // 優先用 adapter 指定游標（考勤彙整可能扣住不完整日）；否則用本批最後一筆
    const cursorSource =
      adapterCursorEvent ||
      (events.length > 0 ? events[events.length - 1] : rawEvents[rawEvents.length - 1]);
    if (cursorSource?.timestamp != null && cursorSource?.id != null) {
      const cursorId = Number(cursorSource.id);
      await db.query(
        `UPDATE external_sync_configs
         SET cursor_ts = ?::timestamptz,
             cursor_event_id = ?
         WHERE id = ?`,
        [
          new Date(cursorSource.timestamp).toISOString(),
          Number.isFinite(cursorId) ? cursorId : null,
          cfg.id,
        ],
      );
    }

    if (logId) {
      await db.query(
        "UPDATE external_sync_run_logs SET finished_at = CURRENT_TIMESTAMP, success = TRUE, row_count = ?, error_message = NULL WHERE id = ?",
        [dataRows.length, logId],
      );
    }
    return { ok: true, eventType, rowCount: dataRows.length };
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

async function deleteConfig(eventType) {
  const type = requireEventType(eventType);
  await db.query("DELETE FROM external_sync_configs WHERE event_type = ?", [type]);
}

module.exports = {
  getConfig,
  listConfigs,
  upsertConfig,
  deleteConfig,
  runExternalSyncOnce,
  testExternalDbConnection,
  listEventTypes,
};
