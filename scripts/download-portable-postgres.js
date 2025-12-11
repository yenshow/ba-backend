#!/usr/bin/env node

/**
 * 跨平台可攜式 PostgreSQL 下載與設定腳本
 * 支援：macOS、Windows、Linux
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");
const os = require("os");

const VERSION = "16.2"; // PostgreSQL 版本（對應 GitHub Releases 標籤 v16.2） // PostgreSQL 版本（對應 GitHub Releases 標籤）
const PROJECT_DIR = path.resolve(__dirname, "..");
const POSTGRES_DIR = path.join(PROJECT_DIR, "postgres");
const BIN_DIR = path.join(POSTGRES_DIR, "bin");
const DATA_DIR = path.join(POSTGRES_DIR, "data");
const LOG_DIR = path.join(POSTGRES_DIR, "logs");

// 顏色輸出（僅在支援的終端顯示）
const colors = {
	reset: "\x1b[0m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m"
};

function log(message, color = "reset") {
	if (process.stdout.isTTY) {
		console.log(`${colors[color]}${message}${colors.reset}`);
	} else {
		console.log(message);
	}
}

// 檢測系統平台
function detectPlatform() {
	const platform = os.platform();
	const arch = os.arch();

	log(`🔍 檢測系統: ${platform} ${arch}`, "green");

	let downloadUrl, archiveName, extractCommand, binExtension;
	let targetTriple = null;

	// 使用 GitHub 開源二進制檔案（theseus-rs/postgresql-binaries）- 無需登入
	if (platform === "darwin") {
		// macOS
		if (arch === "arm64") {
			targetTriple = "aarch64-apple-darwin";
		} else {
			targetTriple = "x86_64-apple-darwin";
		}
		downloadUrl = `https://github.com/theseus-rs/postgresql-binaries/releases/download/v${VERSION}/postgresql-${VERSION}-${targetTriple}.tar.gz`;
		archiveName = `postgresql-${VERSION}-${targetTriple}.tar.gz`;
		extractCommand = "tar";
		binExtension = "";
	} else if (platform === "win32") {
		// Windows
		if (arch === "x64") {
			targetTriple = "x86_64-pc-windows-msvc";
			downloadUrl = `https://github.com/theseus-rs/postgresql-binaries/releases/download/v${VERSION}/postgresql-${VERSION}-${targetTriple}.tar.gz`;
			archiveName = `postgresql-${VERSION}-${targetTriple}.tar.gz`;
			extractCommand = "tar";
		} else {
			throw new Error(`不支援的 Windows 架構: ${arch}`);
		}
		binExtension = ".exe";
	} else if (platform === "linux") {
		// Linux
		if (arch === "x64") {
			targetTriple = "x86_64-unknown-linux-gnu";
		} else if (arch === "arm64") {
			targetTriple = "aarch64-unknown-linux-gnu";
		} else {
			throw new Error(`不支援的 Linux 架構: ${arch}`);
		}
		downloadUrl = `https://github.com/theseus-rs/postgresql-binaries/releases/download/v${VERSION}/postgresql-${VERSION}-${targetTriple}.tar.gz`;
		archiveName = `postgresql-${VERSION}-${targetTriple}.tar.gz`;
		extractCommand = "tar";
		binExtension = "";
	} else {
		throw new Error(`不支援的作業系統: ${platform}`);
	}

	return { downloadUrl, archiveName, extractCommand, binExtension, platform, targetTriple };
}

// 下載檔案
function downloadFile(url, dest) {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(dest);
		const protocol = url.startsWith("https") ? https : http;

		log(`📥 下載 PostgreSQL...`, "yellow");
		log(`   來源: ${url}`, "yellow");
		log(`   目標: ${dest}`, "yellow");

		const options = {
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept: "*/*",
				"Accept-Language": "en-US,en;q=0.9"
			}
		};

		protocol
			.get(url, options, (response) => {
				if (response.statusCode === 301 || response.statusCode === 302) {
					// 處理重定向
					return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
				}
				if (response.statusCode !== 200) {
					let errorMsg = `下載失敗: HTTP ${response.statusCode}`;
					if (response.statusCode === 404) {
						errorMsg += `\n\n⚠️  找不到該版本的二進制檔案。\n   請檢查 https://github.com/theseus-rs/postgresql-binaries/releases 是否有版本 ${VERSION}。`;
					}
					reject(new Error(errorMsg));
					return;
				}

				const totalSize = parseInt(response.headers["content-length"], 10);
				let downloadedSize = 0;

				response.on("data", (chunk) => {
					downloadedSize += chunk.length;
					if (totalSize) {
						const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
						process.stdout.write(`\r   進度: ${percent}% (${(downloadedSize / 1024 / 1024).toFixed(2)} MB)`);
					}
				});

				response.pipe(file);

				file.on("finish", () => {
					file.close();
					console.log(""); // 換行
					resolve();
				});
			})
			.on("error", (err) => {
				fs.unlinkSync(dest);
				reject(err);
			});
	});
}

// 解壓縮檔案
function extractArchive(archivePath, extractCommand, platform) {
	log(`📦 解壓縮...`, "yellow");

	try {
		if (extractCommand === "tar") {
			// 所有平台都使用 tar（GitHub 二進制檔案都是 tar.gz）
			if (platform === "win32") {
				// Windows 需要特殊處理（可能需要安裝 tar 或使用其他工具）
				// 嘗試使用內建的 tar（Windows 10+ 有）
				try {
					execSync(`tar -xzf "${archivePath}" -C "${POSTGRES_DIR}"`, { stdio: "inherit" });
				} catch (error) {
					// 如果 tar 不可用，提示安裝
					throw new Error("Windows 需要 tar 命令。請安裝 Git for Windows 或使用 Windows 10+ 內建的 tar。");
				}
			} else {
				// macOS 和 Linux
				execSync(`tar -xzf "${archivePath}" -C "${POSTGRES_DIR}"`, { stdio: "inherit" });
			}
		} else if (extractCommand === "unzip") {
			// 備用：unzip（如果未來需要）
			execSync(`unzip -q "${archivePath}" -d "${POSTGRES_DIR}"`, { stdio: "inherit" });
		}

		// 刪除壓縮檔
		try {
			if (fs.existsSync(archivePath)) {
				fs.unlinkSync(archivePath);
			}
		} catch (error) {
			// 忽略刪除錯誤
		}

		// 移動檔案到正確位置
		// GitHub 二進制檔案可能直接解壓縮到當前目錄，或包含在一個子目錄中
		const extractedDirs = fs.readdirSync(POSTGRES_DIR).filter((item) => {
			const itemPath = path.join(POSTGRES_DIR, item);
			try {
				const stat = fs.statSync(itemPath);
				if (!stat.isDirectory()) return false;
				// 檢查是否包含 bin 目錄（PostgreSQL 的標誌）
				const binPath = path.join(itemPath, "bin");
				return fs.existsSync(binPath) || item.startsWith("pgsql") || item.toLowerCase().includes("postgresql");
			} catch {
				return false;
			}
		});

		if (extractedDirs.length > 0) {
			// 找到包含 bin 目錄的目錄
			const extractedDir = path.join(POSTGRES_DIR, extractedDirs[0]);
			const extractedBin = path.join(extractedDir, "bin");
			const extractedShare = path.join(extractedDir, "share");
			const extractedLib = path.join(extractedDir, "lib");

			if (fs.existsSync(extractedBin)) {
				if (fs.existsSync(BIN_DIR)) {
					fs.rmSync(BIN_DIR, { recursive: true, force: true });
				}
				fs.renameSync(extractedBin, BIN_DIR);
			}

			if (fs.existsSync(extractedShare)) {
				const targetShare = path.join(POSTGRES_DIR, "share");
				if (fs.existsSync(targetShare)) {
					fs.rmSync(targetShare, { recursive: true, force: true });
				}
				fs.renameSync(extractedShare, targetShare);
			}

			if (fs.existsSync(extractedLib)) {
				const targetLib = path.join(POSTGRES_DIR, "lib");
				if (fs.existsSync(targetLib)) {
					fs.rmSync(targetLib, { recursive: true, force: true });
				}
				fs.renameSync(extractedLib, targetLib);
			}

			// 清理臨時目錄
			fs.rmSync(extractedDir, { recursive: true, force: true });
		} else {
			// 如果沒有找到子目錄，可能直接解壓縮到當前目錄
			// 檢查是否有 bin 目錄在 POSTGRES_DIR
			const directBin = path.join(POSTGRES_DIR, "bin");
			if (fs.existsSync(directBin) && !fs.existsSync(BIN_DIR)) {
				// 已經在正確位置，不需要移動
				log(`✅ 檔案已在正確位置`, "green");
			}
		}

		log(`✅ PostgreSQL 下載完成`, "green");
	} catch (error) {
		throw new Error(`解壓縮失敗: ${error.message}`);
	}
}

// 初始化資料庫
function initDatabase(binExtension) {
	const initdbPath = path.join(BIN_DIR, `initdb${binExtension}`);

	if (fs.existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
		log(`✅ PostgreSQL 資料目錄已存在`, "green");
		return;
	}

	log(`🔧 初始化資料庫...`, "yellow");

	// 建立目錄
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}

	// 執行 initdb
	try {
		const initdbCmd =
			process.platform === "win32"
				? `"${initdbPath}" -D "${DATA_DIR}" --auth-local=trust --auth-host=trust`
				: `"${initdbPath}" -D "${DATA_DIR}" --auth-local=trust --auth-host=trust`;
		execSync(initdbCmd, {
			stdio: "inherit",
			shell: process.platform === "win32"
		});
	} catch (error) {
		throw new Error(`初始化資料庫失敗: ${error.message}`);
	}

	// 設定配置
	const postgresqlConf = path.join(DATA_DIR, "postgresql.conf");
	fs.appendFileSync(postgresqlConf, "\nlisten_addresses = 'localhost'\n");
	fs.appendFileSync(postgresqlConf, "port = 5432\n");
	fs.appendFileSync(postgresqlConf, "max_connections = 100\n");

	const pgHbaConf = path.join(DATA_DIR, "pg_hba.conf");
	fs.appendFileSync(pgHbaConf, "\nhost all all 127.0.0.1/32 trust\n");
	fs.appendFileSync(pgHbaConf, "host all all ::1/128 trust\n");

	log(`✅ 資料庫已初始化`, "green");
}

// 啟動 PostgreSQL
async function startPostgreSQL(binExtension) {
	const pgCtlPath = path.join(BIN_DIR, `pg_ctl${binExtension}`);

	// 檢查是否已在運行
	try {
		execSync(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
			stdio: "pipe",
			shell: process.platform === "win32"
		});
		log(`✅ PostgreSQL 已在運行`, "green");
		return;
	} catch (error) {
		// 未運行，繼續啟動
	}

	log(`🚀 啟動 PostgreSQL...`, "yellow");

	if (!fs.existsSync(LOG_DIR)) {
		fs.mkdirSync(LOG_DIR, { recursive: true });
	}

	const logFile = path.join(LOG_DIR, "postgres.log");

	try {
		const startCmd = `"${pgCtlPath}" -D "${DATA_DIR}" -l "${logFile}" start`;
		execSync(startCmd, {
			stdio: "inherit",
			shell: process.platform === "win32"
		});
		// 等待啟動
		await new Promise((resolve) => setTimeout(resolve, 2000));
		log(`✅ PostgreSQL 已啟動`, "green");
	} catch (error) {
		throw new Error(`啟動 PostgreSQL 失敗: ${error.message}`);
	}
}

// 設定資料庫和使用者
function setupDatabase(binExtension) {
	log(`📝 設定資料庫和使用者...`, "yellow");

	const psqlPath = path.join(BIN_DIR, `psql${binExtension}`);

	// 讀取 .env
	let dbName = "ba_system";
	let dbUser = "postgres";

	if (fs.existsSync(path.join(PROJECT_DIR, ".env"))) {
		const envContent = fs.readFileSync(path.join(PROJECT_DIR, ".env"), "utf8");
		const dbNameMatch = envContent.match(/^DB_NAME=(.+)$/m);
		const dbUserMatch = envContent.match(/^DB_USER=(.+)$/m);
		if (dbNameMatch) dbName = dbNameMatch[1].trim();
		if (dbUserMatch) dbUser = dbUserMatch[1].trim();
	}

	const currentUser = os.userInfo().username;

	try {
		// 建立資料庫
		const dbCheckCmd = `"${psqlPath}" -U "${currentUser}" -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '${dbName}'"`;
		const dbCheck = execSync(dbCheckCmd, {
			encoding: "utf8",
			stdio: "pipe",
			shell: process.platform === "win32"
		});

		if (!dbCheck.trim()) {
			execSync(`"${psqlPath}" -U "${currentUser}" -d postgres -c "CREATE DATABASE ${dbName};"`, {
				stdio: "inherit",
				shell: process.platform === "win32"
			});
		}

		// 建立使用者
		const userCheckCmd = `"${psqlPath}" -U "${currentUser}" -d postgres -tc "SELECT 1 FROM pg_user WHERE usename = '${dbUser}'"`;
		const userCheck = execSync(userCheckCmd, {
			encoding: "utf8",
			stdio: "pipe",
			shell: process.platform === "win32"
		});

		if (!userCheck.trim()) {
			const createUserCmd = `"${psqlPath}" -U "${currentUser}" -d postgres -c "CREATE USER ${dbUser} WITH SUPERUSER PASSWORD 'postgres';"`;
			execSync(createUserCmd, {
				stdio: "inherit",
				shell: process.platform === "win32"
			});
		}

		// 授予權限
		const grantDbCmd = `"${psqlPath}" -U "${currentUser}" -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${dbUser};"`;
		execSync(grantDbCmd, {
			stdio: "inherit",
			shell: process.platform === "win32"
		});
		const grantSchemaCmd = `"${psqlPath}" -U "${currentUser}" -d ${dbName} -c "GRANT ALL ON SCHEMA public TO ${dbUser};"`;
		execSync(grantSchemaCmd, {
			stdio: "inherit",
			shell: process.platform === "win32"
		});

		log(`✅ 資料庫和使用者已設定完成`, "green");

		console.log("");
		log(`🎉 可攜式 PostgreSQL 設定完成！`, "green");
		console.log("");
		console.log("連線資訊:");
		console.log(`  Host: 127.0.0.1`);
		console.log(`  Port: 5432`);
		console.log(`  Database: ${dbName}`);
		console.log(`  User: ${dbUser}`);
		console.log(`  Password: postgres`);
		console.log("");
		console.log("使用方式:");
		console.log(`  啟動: "${path.join(BIN_DIR, `pg_ctl${binExtension}`)}" -D "${DATA_DIR}" start`);
		console.log(`  停止: "${path.join(BIN_DIR, `pg_ctl${binExtension}`)}" -D "${DATA_DIR}" stop`);
		console.log(`  連線: "${psqlPath}" -U ${dbUser} -d ${dbName}`);
	} catch (error) {
		throw new Error(`設定資料庫失敗: ${error.message}`);
	}
}

// 主函數
async function main() {
	try {
		log(`🚀 開始設定可攜式 PostgreSQL...`, "green");

		// 檢測平台
		const { downloadUrl, archiveName, extractCommand, binExtension, platform } = detectPlatform();

		// 建立目錄
		if (!fs.existsSync(POSTGRES_DIR)) {
			fs.mkdirSync(POSTGRES_DIR, { recursive: true });
		}

		// 檢查是否已下載
		const psqlPath = path.join(BIN_DIR, `psql${binExtension}`);
		if (fs.existsSync(psqlPath)) {
			log(`✅ PostgreSQL 二進制檔案已存在`, "green");
		} else {
			// 下載
			const archivePath = path.join(POSTGRES_DIR, archiveName);
			try {
				await downloadFile(downloadUrl, archivePath);
			} catch (error) {
				// 如果下載失敗，提供手動下載說明
				log(`\n❌ 自動下載失敗。請手動下載 PostgreSQL 二進制檔案：`, "red");
				console.log(`\n📥 手動下載步驟（開源版本，無需登入）：`);
				console.log(`1. 訪問: https://github.com/theseus-rs/postgresql-binaries/releases`);
				console.log(`2. 找到版本 v${VERSION}`);
				console.log(`3. 下載對應平台的檔案: ${archiveName}`);
				console.log(`4. 將檔案放置到: ${POSTGRES_DIR}/`);
				console.log(`5. 重新執行此腳本: npm run postgres:download\n`);
				throw error;
			}

			// 解壓縮
			extractArchive(archivePath, extractCommand, platform);
		}

		// 初始化資料庫
		initDatabase(binExtension);

		// 啟動 PostgreSQL
		await startPostgreSQL(binExtension);

		// 設定資料庫和使用者
		setupDatabase(binExtension);
	} catch (error) {
		log(`❌ 錯誤: ${error.message}`, "red");
		process.exit(1);
	}
}

// 執行
if (require.main === module) {
	main();
}

module.exports = { main };
