#!/usr/bin/env node

/**
 * PostgreSQL 可攜式安裝共用模組（Windows 打包／部署）
 * 提供路徑、配置讀取等共用功能
 */

/** 與 scripts/build-and-package.ps1 的 $PgTarRelative 檔名須一致 */
const PG_VERSION = "16.11.0";
const PG_TARGET_TRIPLE = "x86_64-pc-windows-msvc";
const PG_OFFLINE_ARCHIVE_NAME = `postgresql-${PG_VERSION}-${PG_TARGET_TRIPLE}.tar.gz`;

const fs = require("fs");
const path = require("path");
const os = require("os");
const dotenv = require("dotenv");

// 載入 .env 以讀取 DB_PORT 等配置
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const {
  getProjectDir,
  getPostgresDataDir,
  getPostgresLogDir,
} = require("../src/utils/baDataPaths");

const PROJECT_DIR = getProjectDir();
const POSTGRES_DIR = path.join(PROJECT_DIR, "postgres");
const BIN_DIR = path.join(POSTGRES_DIR, "bin");
const DATA_DIR = getPostgresDataDir();
const LOG_DIR = getPostgresLogDir();

const binExtension = process.platform === "win32" ? ".exe" : "";

/**
 * 獲取 PostgreSQL 配置檔案路徑
 */
function getPostgresqlConfPath() {
	return path.join(DATA_DIR, "postgresql.conf");
}

/**
 * 讀取 PostgreSQL 配置中的端口
 * @returns {number} 端口號，預設為 5432
 */
function getPostgresPort() {
	const postgresqlConf = getPostgresqlConfPath();
	if (fs.existsSync(postgresqlConf)) {
		const confContent = fs.readFileSync(postgresqlConf, "utf8");
		const portMatch = confContent.match(/^port\s*=\s*(\d+)/m);
		if (portMatch) {
			return parseInt(portMatch[1], 10);
		}
	}
	// 如果配置檔案不存在或沒有端口設定，從環境變數讀取
	return parseInt(process.env.DB_PORT || "5432", 10);
}

/**
 * 檢查 PostgreSQL 是否已下載
 */
function isPostgresDownloaded() {
	const psqlPath = path.join(BIN_DIR, `psql${binExtension}`);
	return fs.existsSync(psqlPath);
}

/**
 * 檢查資料庫是否已初始化
 */
function isDatabaseInitialized() {
	return fs.existsSync(path.join(DATA_DIR, "PG_VERSION"));
}

/**
 * 獲取可執行檔路徑
 * @param {string} name - 執行檔名稱（不含副檔名）
 * @returns {string} 完整路徑
 */
function getBinPath(name) {
	return path.join(BIN_DIR, `${name}${binExtension}`);
}

function getOfflineArchivePath() {
	return path.join(POSTGRES_DIR, PG_OFFLINE_ARCHIVE_NAME);
}

module.exports = {
	PROJECT_DIR,
	POSTGRES_DIR,
	BIN_DIR,
	DATA_DIR,
	LOG_DIR,
	PG_VERSION,
	PG_TARGET_TRIPLE,
	PG_OFFLINE_ARCHIVE_NAME,
	binExtension,
	getPostgresqlConfPath,
	getPostgresPort,
	isPostgresDownloaded,
	isDatabaseInitialized,
	getBinPath,
	getOfflineArchivePath,
};
