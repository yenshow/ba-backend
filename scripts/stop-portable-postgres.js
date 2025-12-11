#!/usr/bin/env node

/**
 * 跨平台停止可攜式 PostgreSQL
 * 支援：macOS、Windows、Linux
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT_DIR = path.resolve(__dirname, "..");
const POSTGRES_DIR = path.join(PROJECT_DIR, "postgres");
const BIN_DIR = path.join(POSTGRES_DIR, "bin");
const DATA_DIR = path.join(POSTGRES_DIR, "data");

const binExtension = process.platform === "win32" ? ".exe" : "";
const pgCtlPath = path.join(BIN_DIR, `pg_ctl${binExtension}`);

if (!fs.existsSync(pgCtlPath)) {
	console.error("❌ PostgreSQL 尚未下載");
	process.exit(1);
}

try {
	// 檢查是否在運行
	execSync(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
		stdio: "pipe",
		shell: process.platform === "win32"
	});
	// 在運行，停止
	console.log("🛑 停止 PostgreSQL...");
	execSync(`"${pgCtlPath}" -D "${DATA_DIR}" stop`, {
		stdio: "inherit",
		shell: process.platform === "win32"
	});
	console.log("✅ PostgreSQL 已停止");
} catch (error) {
	// 未運行
	console.log("✅ PostgreSQL 未運行");
}
