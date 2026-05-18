const { Pool } = require("pg");
const logger = require("../utils/logger");

const externalDbLogger = logger.createLogger("externalDb");

/** @type {import("pg").Pool | null} */
let externalPool = null;

const createPool = (credentials) =>
  new Pool({
    host: credentials.host,
    port: credentials.port,
    user: credentials.user,
    password: credentials.password,
    database: credentials.database,
    max: credentials.connectionLimit ?? 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

async function reconnect(credentials) {
  if (externalPool) {
    try {
      await externalPool.end();
    } catch (err) {
      externalDbLogger.warn("關閉舊外部資料庫連線池時發生錯誤", {
        error: err?.message || String(err),
      });
    }
    externalPool = null;
  }
  externalPool = createPool(credentials);
  externalDbLogger.info("外部資料庫連線池已重建", {
    host: credentials.host,
    module: "externalDb",
  });
}

async function testConnection() {
  if (!externalPool) {
    externalDbLogger.warn("外部資料庫連線池尚未初始化", { module: "externalDb" });
    return false;
  }
  try {
    await externalPool.query("SELECT NOW()");
    externalDbLogger.info("外部資料庫連線成功", { module: "externalDb" });
    return true;
  } catch (error) {
    externalDbLogger.error("外部資料庫連線失敗", {
      error: error?.message || String(error),
      module: "externalDb",
    });
    return false;
  }
}

function convertQueryParams(sql, params) {
  if (!params || params.length === 0) {
    return { sql, params: [] };
  }
  let paramIndex = 1;
  const convertedSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
  return { sql: convertedSql, params };
}

async function query(sql, params = []) {
  if (!externalPool) {
    throw new Error("外部資料庫連線池尚未初始化");
  }
  try {
    const { sql: convertedSql, params: convertedParams } = convertQueryParams(
      sql,
      params,
    );
    const result = await externalPool.query(convertedSql, convertedParams);
    const rows = result.rows;
    rows.rowCount = result.rowCount;
    return rows;
  } catch (error) {
    externalDbLogger.error("外部資料庫查詢錯誤", {
      error: error?.message || String(error),
      module: "externalDb",
    });
    throw error;
  }
}

async function close() {
  if (!externalPool) return;
  await externalPool.end();
  externalPool = null;
  externalDbLogger.info("外部資料庫連線池已關閉", { module: "externalDb" });
}

module.exports = {
  get pool() {
    return externalPool;
  },
  reconnect,
  query,
  testConnection,
  close,
};
