const { Pool } = require("pg");
const config = require("../config");
const logger = require("../utils/logger");

const externalDbLogger = logger.createLogger("externalDb");

// 建立外部資料庫連線池
const externalPool = new Pool({
  host: config.externalDatabase.host,
  port: config.externalDatabase.port,
  user: config.externalDatabase.user,
  password: config.externalDatabase.password,
  database: config.externalDatabase.database,
  max: config.externalDatabase.connectionLimit,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 測試連線
async function testConnection() {
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

// 將 ? 佔位符轉換為 PostgreSQL 的 $1, $2, ...
function convertQueryParams(sql, params) {
  if (!params || params.length === 0) {
    return { sql, params: [] };
  }
  let paramIndex = 1;
  const convertedSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
  return { sql: convertedSql, params };
}

// 執行查詢
async function query(sql, params = []) {
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

// 關閉連線池
async function close() {
  await externalPool.end();
  externalDbLogger.info("外部資料庫連線池已關閉", { module: "externalDb" });
}

module.exports = {
  pool: externalPool,
  query,
  testConnection,
  close,
};
