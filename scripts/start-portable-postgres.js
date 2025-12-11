#!/usr/bin/env node

/**
 * 跨平台啟動可攜式 PostgreSQL
 * 支援：macOS、Windows、Linux
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

const PROJECT_DIR = path.resolve(__dirname, "..");
const POSTGRES_DIR = path.join(PROJECT_DIR, "postgres");
const BIN_DIR = path.join(POSTGRES_DIR, "bin");
const DATA_DIR = path.join(POSTGRES_DIR, "data");
const LOG_DIR = path.join(POSTGRES_DIR, "logs");

const binExtension = process.platform === "win32" ? ".exe" : "";
const pgCtlPath = path.join(BIN_DIR, `pg_ctl${binExtension}`);

if (!fs.existsSync(pgCtlPath)) {
	console.error("❌ PostgreSQL 尚未下載");
	console.error("請先執行: npm run postgres:download");
	process.exit(1);
}

if (!fs.existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
	console.error("❌ 資料庫尚未初始化");
	console.error("請先執行: npm run postgres:download");
	process.exit(1);
}

try {
	// 檢查是否已在運行
	execSync(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
		stdio: "pipe",
		shell: process.platform === "win32"
	});
	console.log("✅ PostgreSQL 已在運行");
} catch (error) {
	// 未運行，啟動
	console.log("🚀 啟動 PostgreSQL...");

	if (!fs.existsSync(LOG_DIR)) {
		fs.mkdirSync(LOG_DIR, { recursive: true });
	}

	const logFile = path.join(LOG_DIR, "postgres.log");

	try {
		execSync(`"${pgCtlPath}" -D "${DATA_DIR}" -l "${logFile}" start`, {
			stdio: "inherit",
			shell: process.platform === "win32"
		});
		setTimeout(() => {}, 1000);
		console.log("✅ PostgreSQL 已啟動");
	} catch (error) {
		console.error(`❌ 啟動失敗: ${error.message}`);
		process.exit(1);
	}
}
