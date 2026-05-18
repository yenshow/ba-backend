#!/usr/bin/env node

/**
 * 停止可攜式 PostgreSQL（Windows）
 */

const { DATA_DIR, getBinPath, isPostgresDownloaded } = require("./postgres-common");
const { execWithUtf8OnWindows } = require("./postgres-exec-windows");

if (!isPostgresDownloaded()) {
  console.error("❌ PostgreSQL 尚未安裝");
  process.exit(1);
}

const pgCtlPath = getBinPath("pg_ctl");

try {
  execWithUtf8OnWindows(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
    stdio: "pipe",
  });
  console.log("🛑 停止 PostgreSQL...");
  execWithUtf8OnWindows(`"${pgCtlPath}" -D "${DATA_DIR}" stop`, {
    stdio: "inherit",
  });
  console.log("✅ PostgreSQL 已停止");
} catch {
  console.log("✅ PostgreSQL 未運行");
}
