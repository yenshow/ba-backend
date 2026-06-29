const { Pool } = require("pg");
const logger = require("../utils/logger");

const externalDbLogger = logger.createLogger("externalDb");

/** @type {import("pg").Pool | null} */
let externalPool = null;

/** @type {object | null} */
let currentCredentials = null;

let ensureConnectedRunning = false;
let retryTimer = null;
/** @type {((ctx: { isReconnect: boolean }) => Promise<void>) | null} */
let onConnectedCallback = null;
let wasReady = false;
let hadConnectedOnce = false;

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "57P01",
  "57P03",
  "08006",
  "08001",
  "08004",
]);

const isConnectionError = (error) => {
  if (!error) return false;
  if (CONNECTION_ERROR_CODES.has(error.code)) return true;
  const message = String(error.message || "");
  return (
    message.includes("Connection terminated") ||
    message.includes("connection timeout") ||
    message.includes("Client has encountered a connection error")
  );
};

const attachPoolErrorHandler = (pool) => {
  pool.on("error", (err) => {
    externalDbLogger.warn("外部資料庫連線池錯誤", {
      error: err?.message || String(err),
      module: "externalDb",
    });
    wasReady = false;
  });
};

const createPool = (credentials) => {
  const pool = new Pool({
    host: credentials.host,
    port: credentials.port,
    user: credentials.user,
    password: credentials.password,
    database: credentials.database,
    max: credentials.connectionLimit ?? 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  attachPoolErrorHandler(pool);
  return pool;
};

const clearRetryTimer = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
};

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
  currentCredentials = credentials;
  externalPool = createPool(credentials);
  externalDbLogger.info("外部資料庫連線池已重建", {
    host: credentials.host,
    module: "externalDb",
  });
}

async function isConnected() {
  if (!externalPool) {
    return false;
  }
  try {
    await externalPool.query("SELECT 1");
    return true;
  } catch {
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

async function executeQuery(sql, params = []) {
  const { sql: convertedSql, params: convertedParams } = convertQueryParams(
    sql,
    params,
  );
  const result = await externalPool.query(convertedSql, convertedParams);
  const rows = result.rows;
  rows.rowCount = result.rowCount;
  return rows;
}

async function query(sql, params = []) {
  if (!externalPool) {
    throw new Error("外部資料庫連線池尚未初始化");
  }
  try {
    return await executeQuery(sql, params);
  } catch (error) {
    if (isConnectionError(error) && currentCredentials) {
      externalDbLogger.warn("外部資料庫查詢連線錯誤，嘗試重連後重試", {
        error: error?.message || String(error),
        module: "externalDb",
      });
      wasReady = false;
      await reconnect(currentCredentials);
      return await executeQuery(sql, params);
    }
    externalDbLogger.error("外部資料庫查詢錯誤", {
      error: error?.message || String(error),
      module: "externalDb",
    });
    throw error;
  }
}

const scheduleNextAttempt = (retryIntervalMs) => {
  clearRetryTimer();
  retryTimer = setTimeout(() => {
    void runEnsureConnectedAttempt(retryIntervalMs);
  }, retryIntervalMs);
};

async function runEnsureConnectedAttempt(retryIntervalMs) {
  if (!ensureConnectedRunning || !currentCredentials) {
    return;
  }

  let ready = false;
  try {
    if (!externalPool || !(await isConnected())) {
      await reconnect(currentCredentials);
      ready = await isConnected();
    } else {
      ready = true;
    }
  } catch (error) {
    externalDbLogger.warn("外部資料庫連線嘗試失敗", {
      error: error?.message || String(error),
      module: "externalDb",
    });
    ready = false;
  }

  if (ready && !wasReady && onConnectedCallback) {
    const isReconnect = hadConnectedOnce;
    hadConnectedOnce = true;
    try {
      await onConnectedCallback({ isReconnect });
    } catch (error) {
      externalDbLogger.warn("外部資料庫 onConnected 回呼失敗", {
        error: error?.message || String(error),
        module: "externalDb",
      });
    }
  }

  if (ready) {
    wasReady = true;
  } else {
    wasReady = false;
    externalDbLogger.warn("外部資料庫連線失敗，將重試", { module: "externalDb" });
  }

  scheduleNextAttempt(retryIntervalMs);
}

async function ensureConnected(credentials, { onConnected, retryIntervalMs = 30000 } = {}) {
  stopEnsureConnected();
  ensureConnectedRunning = true;
  currentCredentials = credentials;
  onConnectedCallback = onConnected ?? null;
  wasReady = false;

  await runEnsureConnectedAttempt(retryIntervalMs);
}

function stopEnsureConnected() {
  clearRetryTimer();
  ensureConnectedRunning = false;
  onConnectedCallback = null;
}

async function close() {
  stopEnsureConnected();
  if (!externalPool) return;
  await externalPool.end();
  externalPool = null;
  currentCredentials = null;
  wasReady = false;
  hadConnectedOnce = false;
  externalDbLogger.info("外部資料庫連線池已關閉", { module: "externalDb" });
}

module.exports = {
  get pool() {
    return externalPool;
  },
  reconnect,
  ensureConnected,
  stopEnsureConnected,
  isConnected,
  query,
  close,
};
