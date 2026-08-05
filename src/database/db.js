const { Pool, Client } = require("pg");
const config = require("../config");
const logger = require("../utils/logger");

const dbLogger = logger.createLogger("db");

// 建立連線池
const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.database,
  max: config.database.connectionLimit,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// 測試連線
async function testConnection() {
  try {
    await pool.query("SELECT NOW()");
    dbLogger.info("資料庫連線成功", { module: "db" });
    return true;
  } catch (error) {
    dbLogger.error("資料庫連線失敗", {
      error: error?.message || String(error),
      module: "db",
    });
    return false;
  }
}

/**
 * 開機時等 PostgreSQL 就緒（SCM 並行啟動 PostgreSQL／Backend 時避免半殘 online）。
 * 使用短連線逾時探測，避免每次失敗卡滿 pool 的 10s。
 * @param {{ timeoutMs?: number, intervalMs?: number, logger?: { info: Function, warn: Function, error: Function } }} [options]
 * @returns {Promise<boolean>}
 */
async function waitForDatabase(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 90_000;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 2_000;
  const log = options.logger || dbLogger;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let loggedWaiting = false;

  const probeConfig = {
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    connectionTimeoutMillis: Math.min(intervalMs, 3_000),
  };

  while (Date.now() < deadline) {
    attempt += 1;
    const client = new Client(probeConfig);
    try {
      await client.connect();
      await client.query("SELECT 1");
      log.info(attempt > 1 ? "資料庫已就緒" : "資料庫連線成功", {
        attempts: attempt,
        module: "db",
      });
      return true;
    } catch (error) {
      if (!loggedWaiting) {
        log.warn("等待資料庫就緒…", {
          error: error?.message || String(error),
          timeoutMs,
          module: "db",
        });
        loggedWaiting = true;
      }
    } finally {
      try {
        await client.end();
      } catch (_e) {
        // ignore
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, remaining)),
    );
  }

  log.error("等待資料庫逾時", { timeoutMs, attempts: attempt, module: "db" });
  return false;
}

// 將 ? 佔位符轉換為 PostgreSQL 的 $1, $2, ...
function convertQueryParams(sql, params) {
  if (!params || params.length === 0) {
    return { sql, params: [] };
  }
  let paramIndex = 1;
  const convertedSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
  return { sql: convertedSql, params };
}

// 執行查詢（使用連線池）
async function query(sql, params = []) {
  try {
    const { sql: convertedSql, params: convertedParams } = convertQueryParams(
      sql,
      params,
    );
    const result = await pool.query(convertedSql, convertedParams);
    // 返回 rows，但添加 rowCount 屬性以便訪問
    const rows = result.rows;
    rows.rowCount = result.rowCount;
    return rows;
  } catch (error) {
    dbLogger.error("資料庫查詢錯誤", {
      error: error?.message || String(error),
      module: "db",
    });
    throw error;
  }
}

// 執行事務
async function transaction(callback) {
  const client = await pool.connect();

  // 為 client 提供包裝的 query 方法，支援參數轉換並返回 rows + rowCount
  const clientQuery = async (sql, params = []) => {
    const { sql: convertedSql, params: convertedParams } = convertQueryParams(
      sql,
      params
    );
    const result = await client.query(convertedSql, convertedParams);
    const rows = result.rows;
    rows.rowCount = result.rowCount;
    return rows;
  };

  try {
    await client.query("BEGIN");
    const result = await callback(clientQuery);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// 關閉連線池
async function close() {
  await pool.end();
  dbLogger.info("資料庫連線池已關閉", { module: "db" });
}

module.exports = {
  pool,
  query,
  transaction,
  testConnection,
  waitForDatabase,
  close,
};
