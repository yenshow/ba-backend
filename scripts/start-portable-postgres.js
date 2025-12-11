#!/usr/bin/env node

/**
 * 跨平台啟動可攜式 PostgreSQL
 * 支援：macOS、Windows、Linux
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { BIN_DIR, DATA_DIR, LOG_DIR, binExtension, getBinPath, isPostgresDownloaded, isDatabaseInitialized } = require("./postgres-common");

if (!isPostgresDownloaded()) {
	console.error("❌ PostgreSQL 尚未下載");
	console.error("請先執行: npm run postgres:download");
	process.exit(1);
}

if (!isDatabaseInitialized()) {
	console.error("❌ 資料庫尚未初始化");
	console.error("請先執行: npm run postgres:download");
	process.exit(1);
}

const pgCtlPath = getBinPath("pg_ctl");

(async () => {
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
			// 等待啟動完成
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// 驗證是否成功啟動
			try {
				execSync(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
					stdio: "pipe",
					shell: process.platform === "win32"
				});
				console.log("✅ PostgreSQL 已啟動");
			} catch (error) {
				console.error(`❌ 啟動失敗: 無法驗證 PostgreSQL 狀態`);
				if (fs.existsSync(logFile)) {
					const logContent = fs.readFileSync(logFile, "utf8");
					const lastError = logContent
						.split("\n")
						.filter((line) => line.includes("FATAL") || line.includes("ERROR"))
						.slice(-3)
						.join("\n");
					if (lastError) {
						console.error(`\n日誌錯誤：\n${lastError}`);
					}
				}
				process.exit(1);
			}
		} catch (error) {
			console.error(`❌ 啟動失敗: ${error.message}`);
			process.exit(1);
		}
	}
})();
