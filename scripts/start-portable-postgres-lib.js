#!/usr/bin/env node

/**
 * 可攜式 PostgreSQL 啟動（Windows 部署／精靈共用）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  DATA_DIR,
  LOG_DIR,
  getBinPath,
  getPostgresPort,
  getPostgresqlConfPath,
} = require("./postgres-common");
const { log, execWithUtf8OnWindows } = require("./postgres-exec-windows");

const PSQL_HOST = "127.0.0.1";
const PSQL_COMMON_ARGS = "-X -w -v ON_ERROR_STOP=1";

const sleepMs = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const readRecentLogErrors = (logFile, maxLines = 5) => {
  if (!fs.existsSync(logFile)) {
    return "";
  }
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.includes("FATAL") || line.includes("ERROR"))
    .slice(-maxLines)
    .join("\n");
};

const isPgCtlRunning = () => {
  const pgCtlPath = getBinPath("pg_ctl");
  try {
    execWithUtf8OnWindows(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
};

const verifyPsqlReady = (maxAttempts = 30, delayMs = 500) => {
  const psqlPath = getBinPath("psql");
  const port = getPostgresPort();
  const currentUser = os.userInfo().username;

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      execWithUtf8OnWindows(
        `"${psqlPath}" ${PSQL_COMMON_ARGS} -h "${PSQL_HOST}" -p ${port} -U "${currentUser}" -d postgres -c "SELECT 1;"`,
        { encoding: "utf8", stdio: "pipe" },
      );
      return;
    } catch {
      if (i === maxAttempts) {
        throw new Error(
          `PostgreSQL 已啟動但仍無法連線（${PSQL_HOST}:${port}）。請檢查 ${path.join(LOG_DIR, "postgres.log")}`,
        );
      }
      sleepMs(delayMs);
    }
  }
};

const checkPortAvailable = (port) => {
  try {
    const result = execWithUtf8OnWindows(`netstat -ano | findstr :${port}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    return result.trim().length === 0;
  } catch {
    return true;
  }
};

/**
 * 啟動可攜式 PostgreSQL（已運行則驗證連線後返回）
 * @param {{ quiet?: boolean }} options
 */
function startPortablePostgres(options = {}) {
  const quiet = options.quiet === true;
  const say = (message, color) => {
    if (!quiet) {
      log(message, color);
    }
  };

  const pgCtlPath = getBinPath("pg_ctl");
  const port = getPostgresPort();
  const postgresqlConf = getPostgresqlConfPath();
  const logFile = path.join(LOG_DIR, "postgres.log");

  if (isPgCtlRunning()) {
    say(`✅ PostgreSQL 已在運行 (埠號: ${port})`, "green");
    verifyPsqlReady();
    if (!quiet) {
      log(`✅ PostgreSQL 連線驗證成功`, "green");
    }
    return { alreadyRunning: true };
  }

  if (!checkPortAvailable(port)) {
    console.log(`\n可能的原因：`);
    console.log(`  - 系統已安裝的 PostgreSQL 正在運行`);
    console.log(`  - 其他應用程式正在使用埠 ${port}`);
    console.log(`\n解決方案：`);
    console.log(`  netstat -ano | findstr :${port}`);
    console.log(`  taskkill /PID <PID> /F`);
    console.log(`\n或修改 ${postgresqlConf} 中的 port\n`);
    throw new Error(`埠 ${port} 已被占用，無法啟動 PostgreSQL`);
  }

  say(`🚀 啟動 PostgreSQL (埠號: ${port})...`, "yellow");

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const startCmd = `"${pgCtlPath}" -D "${DATA_DIR}" -l "${logFile}" start`;
  try {
    execWithUtf8OnWindows(startCmd, { stdio: "inherit" });
  } catch (error) {
    const logErrors = readRecentLogErrors(logFile, 3);
    let message = `啟動 PostgreSQL 失敗: ${error.message}`;
    if (logErrors) {
      message += `\n\n日誌錯誤：\n${logErrors}`;
    }
    throw new Error(message);
  }

  say("⏳ 等待 PostgreSQL 就緒...", "yellow");
  verifyPsqlReady();
  say(`✅ PostgreSQL 已啟動並可連線 (埠號: ${port})`, "green");
  return { alreadyRunning: false };
}

module.exports = {
  startPortablePostgres,
  verifyPsqlReady,
  readRecentLogErrors,
  PSQL_HOST,
  PSQL_COMMON_ARGS,
};
