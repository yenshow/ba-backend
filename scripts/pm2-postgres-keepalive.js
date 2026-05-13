#!/usr/bin/env node
/**
 * PM2-friendly portable PostgreSQL supervisor.
 *
 * Why: `start-portable-postgres.js` only starts postgres then exits.
 * PM2 expects a long-running process to supervise across reboots.
 *
 * Behavior:
 * - Ensures portable postgres is running; if not, attempts to start it.
 * - Periodically checks `pg_ctl status` and a simple `psql SELECT 1`.
 * - On SIGINT/SIGTERM, attempts to stop postgres gracefully.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const {
  DATA_DIR,
  LOG_DIR,
  getBinPath,
  getPostgresPort,
  isPostgresDownloaded,
  isDatabaseInitialized,
} = require("./postgres-common");

const pgCtlPath = getBinPath("pg_ctl");
const psqlPath = getBinPath("psql");
const host = "127.0.0.1";

const log = (msg) => console.log(`[ba-postgres] ${msg}`);

const run = (cmd, opts = {}) =>
  execSync(cmd, {
    stdio: "pipe",
    shell: process.platform === "win32",
    ...opts,
  });

const ensureDirs = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
};

const isPgCtlRunning = () => {
  try {
    run(`"${pgCtlPath}" -D "${DATA_DIR}" status`);
    return true;
  } catch {
    return false;
  }
};

const canPsqlConnect = () => {
  const port = getPostgresPort();
  const currentUser = require("os").userInfo().username;

  try {
    run(
      `"${psqlPath}" -h "${host}" -p ${port} -U "${currentUser}" -d postgres -c "SELECT 1;"`,
      { encoding: "utf8" },
    );
    return true;
  } catch {
    return false;
  }
};

const sleepMs = async (ms) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const startPostgres = async () => {
  ensureDirs();
  const logFile = path.join(LOG_DIR, "postgres.log");
  const port = getPostgresPort();

  log(`starting postgres (port=${port})...`);
  execSync(`"${pgCtlPath}" -D "${DATA_DIR}" -l "${logFile}" start`, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  // Wait until it is actually accepting connections.
  for (let i = 1; i <= 30; i++) {
    if (isPgCtlRunning() && canPsqlConnect()) {
      log("postgres is up.");
      return;
    }
    await sleepMs(500);
  }

  throw new Error(`postgres start timed out. Check log: ${logFile}`);
};

const stopPostgres = () => {
  try {
    if (!isPgCtlRunning()) return;
    log("stopping postgres...");
    execSync(`"${pgCtlPath}" -D "${DATA_DIR}" stop -m fast`, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  } catch (e) {
    log(`stop failed: ${e?.message || e}`);
  }
};

const main = async () => {
  if (!isPostgresDownloaded()) {
    throw new Error(
      "portable postgres binaries not found. Run: npm run postgres:download",
    );
  }
  if (!isDatabaseInitialized()) {
    throw new Error(
      "portable postgres data dir not initialized. Run: npm run postgres:download",
    );
  }

  if (!isPgCtlRunning() || !canPsqlConnect()) {
    await startPostgres();
  } else {
    log(`postgres already running (port=${getPostgresPort()}).`);
  }

  // Keepalive loop: if postgres dies, crash so PM2 restarts us.
  setInterval(() => {
    const ok = isPgCtlRunning() && canPsqlConnect();
    if (ok) return;
    throw new Error("postgres is not healthy (status/connect failed).");
  }, 5000);
};

process.on("SIGINT", () => {
  stopPostgres();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopPostgres();
  process.exit(0);
});

main().catch((e) => {
  console.error(`[ba-postgres] fatal: ${e?.message || e}`);
  process.exit(1);
});

