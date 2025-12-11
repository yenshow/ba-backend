#!/usr/bin/env node

/**
 * 跨平台停止可攜式 PostgreSQL
 * 支援：macOS、Windows、Linux
 */

const { execSync } = require("child_process");
const { DATA_DIR, getBinPath, isPostgresDownloaded } = require("./postgres-common");

if (!isPostgresDownloaded()) {
	console.error("❌ PostgreSQL 尚未下載");
	process.exit(1);
}

const pgCtlPath = getBinPath("pg_ctl");

try {
	// 檢查是否在運行
	execSync(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
		stdio: "pipe",
		shell: process.platform === "win32" ? true : false
	});
	// 在運行，停止
	console.log("🛑 停止 PostgreSQL...");
	execSync(`"${pgCtlPath}" -D "${DATA_DIR}" stop`, {
		stdio: "inherit",
		shell: process.platform === "win32" ? true : false
	});
	console.log("✅ PostgreSQL 已停止");
} catch (error) {
	// 未運行
	console.log("✅ PostgreSQL 未運行");
}
