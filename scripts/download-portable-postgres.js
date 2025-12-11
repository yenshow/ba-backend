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

const VERSION = "16.11.0"; // PostgreSQL 版本（對應 GitHub Releases 標籤，例如 v16.11.0）
const {
	PROJECT_DIR,
	POSTGRES_DIR,
	BIN_DIR,
	DATA_DIR,
	LOG_DIR,
	binExtension: commonBinExtension,
	getPostgresPort,
	getPostgresqlConfPath
} = require("./postgres-common");

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

	return { downloadUrl, archiveName, extractCommand, platform, targetTriple };
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

					// 驗證下載的檔案是否有效
					try {
						const stats = fs.statSync(dest);
						if (stats.size === 0) {
							fs.unlinkSync(dest);
							reject(new Error("下載的檔案為空，請檢查網路連線或檔案來源"));
							return;
						}
						// 檢查是否為有效的 gzip 檔案（至少檢查檔案大小）
						if (stats.size < 1024) {
							fs.unlinkSync(dest);
							reject(new Error("下載的檔案過小，可能不完整"));
							return;
						}
					} catch (error) {
						reject(new Error(`無法驗證下載的檔案: ${error.message}`));
						return;
					}

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

	// 檢查壓縮檔是否存在
	if (!fs.existsSync(archivePath)) {
		throw new Error(`壓縮檔不存在: ${archivePath}`);
	}

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

		// 移動檔案到正確位置
		// GitHub 二進制檔案可能直接解壓縮到當前目錄，或包含在一個子目錄中
		const extractedDirs = fs.readdirSync(POSTGRES_DIR).filter((item) => {
			const itemPath = path.join(POSTGRES_DIR, item);
			try {
				const stat = fs.statSync(itemPath);
				if (!stat.isDirectory()) return false;
				// 排除已知目錄
				if (item === "data" || item === "logs") return false;
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
			if (fs.existsSync(directBin)) {
				// 已經在正確位置，不需要移動
				log(`✅ 檔案已在正確位置`, "green");
			} else {
				// 解壓縮後沒有找到 bin 目錄，可能是壓縮檔格式不對或損壞
				throw new Error(`解壓縮後未找到 bin 目錄。請檢查壓縮檔是否正確。\n解壓縮目錄內容: ${fs.readdirSync(POSTGRES_DIR).join(", ")}`);
			}
		}

		// 驗證解壓縮是否成功
		const psqlPath = path.join(BIN_DIR, `psql${commonBinExtension}`);
		if (!fs.existsSync(psqlPath)) {
			throw new Error(`解壓縮驗證失敗：找不到 psql 執行檔。請檢查壓縮檔是否正確。`);
		}

		// 只有在驗證成功後才刪除壓縮檔
		try {
			if (fs.existsSync(archivePath)) {
				fs.unlinkSync(archivePath);
				log(`✅ 已清理壓縮檔`, "green");
			}
		} catch (error) {
			// 忽略刪除錯誤
			log(`⚠️  無法刪除壓縮檔: ${error.message}`, "yellow");
		}

		log(`✅ PostgreSQL 下載完成`, "green");
	} catch (error) {
		// 解壓縮失敗時保留壓縮檔以便重新嘗試
		log(`❌ 解壓縮失敗，壓縮檔已保留: ${archivePath}`, "red");
		throw new Error(`解壓縮失敗: ${error.message}`);
	}
}

// 初始化資料庫
function initDatabase() {
	const initdbPath = path.join(BIN_DIR, `initdb${commonBinExtension}`);

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
		const initdbCmd = `"${initdbPath}" -D "${DATA_DIR}" --auth-local=trust --auth-host=trust`;
		execSync(initdbCmd, {
			stdio: "inherit",
			shell: process.platform === "win32"
		});
	} catch (error) {
		throw new Error(`初始化資料庫失敗: ${error.message}`);
	}

	// 設定配置
	const postgresqlConf = getPostgresqlConfPath();
	// 從環境變數讀取端口，預設為 5432
	const dbPort = process.env.DB_PORT || "5432";
	fs.appendFileSync(postgresqlConf, "\nlisten_addresses = 'localhost'\n");
	fs.appendFileSync(postgresqlConf, `port = ${dbPort}\n`);
	fs.appendFileSync(postgresqlConf, "max_connections = 100\n");

	const pgHbaConf = path.join(DATA_DIR, "pg_hba.conf");
	fs.appendFileSync(pgHbaConf, "\nhost all all 127.0.0.1/32 trust\n");
	fs.appendFileSync(pgHbaConf, "host all all ::1/128 trust\n");

	log(`✅ 資料庫已初始化`, "green");
}

// 檢查端口是否被占用
function checkPortAvailable(port) {
	try {
		if (process.platform === "win32") {
			const result = execSync(`netstat -ano | findstr :${port}`, {
				stdio: "pipe",
				encoding: "utf8"
			});
			return result.trim().length === 0;
		} else {
			const result = execSync(`lsof -i :${port}`, {
				stdio: "pipe",
				encoding: "utf8"
			});
			return result.trim().length === 0;
		}
	} catch (error) {
		// 如果命令失敗（例如沒有 lsof），假設端口可用
		return true;
	}
}

// 啟動 PostgreSQL
async function startPostgreSQL() {
	const pgCtlPath = path.join(BIN_DIR, `pg_ctl${commonBinExtension}`);

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

	// 讀取配置中的端口
	const port = getPostgresPort();
	const postgresqlConf = getPostgresqlConfPath();

	// 檢查端口是否被占用
	if (!checkPortAvailable(port)) {
		log(`\n⚠️  端口 ${port} 已被占用`, "yellow");
		console.log(`\n可能的原因：`);
		console.log(`  - 系統已安裝的 PostgreSQL 正在運行`);
		console.log(`  - 其他應用程式正在使用該端口`);
		console.log(`\n解決方案：`);
		console.log(`  1. 停止其他 PostgreSQL 實例：`);
		if (process.platform === "win32") {
			console.log(`     netstat -ano | findstr :${port}`);
			console.log(`     taskkill /PID <PID> /F`);
		} else {
			console.log(`     lsof -i :${port}`);
			console.log(`     kill <PID>`);
		}
		console.log(`\n  2. 或修改配置使用不同端口：`);
		console.log(`     編輯 ${postgresqlConf}`);
		console.log(`     將 port = ${port} 改為其他端口（例如 5433）`);
		console.log(`     然後重新執行此腳本\n`);
		throw new Error(`端口 ${port} 已被占用，無法啟動 PostgreSQL`);
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

		// 驗證是否成功啟動
		try {
			execSync(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
				stdio: "pipe",
				shell: process.platform === "win32"
			});
			log(`✅ PostgreSQL 已啟動`, "green");
		} catch (error) {
			// 啟動失敗，讀取日誌
			let errorMsg = `啟動 PostgreSQL 失敗`;
			if (fs.existsSync(logFile)) {
				const logContent = fs.readFileSync(logFile, "utf8");
				const lastError = logContent
					.split("\n")
					.filter((line) => line.includes("FATAL") || line.includes("ERROR"))
					.slice(-3)
					.join("\n");
				if (lastError) {
					errorMsg += `\n\n日誌錯誤：\n${lastError}`;
				}
			}
			throw new Error(errorMsg);
		}
	} catch (error) {
		throw new Error(`啟動 PostgreSQL 失敗: ${error.message}`);
	}
}

// 設定資料庫和使用者
function setupDatabase() {
	log(`📝 設定資料庫和使用者...`, "yellow");

	const psqlPath = path.join(BIN_DIR, `psql${commonBinExtension}`);

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
		const displayPort = getPostgresPort();
		console.log("連線資訊:");
		console.log(`  Host: 127.0.0.1`);
		console.log(`  Port: ${displayPort}`);
		console.log(`  Database: ${dbName}`);
		console.log(`  User: ${dbUser}`);
		console.log(`  Password: postgres`);
		console.log("");
		console.log("使用方式:");
		console.log(`  啟動: "${path.join(BIN_DIR, `pg_ctl${commonBinExtension}`)}" -D "${DATA_DIR}" start`);
		console.log(`  停止: "${path.join(BIN_DIR, `pg_ctl${commonBinExtension}`)}" -D "${DATA_DIR}" stop`);
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
		const { downloadUrl, archiveName, extractCommand, platform, targetTriple } = detectPlatform();

		// 建立目錄
		if (!fs.existsSync(POSTGRES_DIR)) {
			fs.mkdirSync(POSTGRES_DIR, { recursive: true });
		}

		// 檢查是否已下載
		const psqlPath = path.join(BIN_DIR, `psql${commonBinExtension}`);
		if (fs.existsSync(psqlPath)) {
			log(`✅ PostgreSQL 二進制檔案已存在`, "green");
		} else {
			// 檢查是否已有壓縮檔（優先使用精確匹配的檔案名稱）
			let archivePath = path.join(POSTGRES_DIR, archiveName);
			let archiveExists = fs.existsSync(archivePath);

			// 如果精確匹配的檔案不存在，嘗試尋找同平台的任何版本
			if (!archiveExists) {
				log(`🔍 尋找手動下載的壓縮檔...`, "yellow");
				const files = fs.readdirSync(POSTGRES_DIR).filter((file) => {
					// 檢查是否為 tar.gz 檔案且包含目標平台標識符
					return file.endsWith(".tar.gz") && file.includes(targetTriple) && file.startsWith("postgresql-");
				});

				if (files.length > 0) {
					archivePath = path.join(POSTGRES_DIR, files[0]);
					archiveExists = true;
					log(`✅ 找到手動下載的檔案: ${files[0]}`, "green");
				}
			}

			// 如果檔案存在，驗證是否有效（不是空的）
			if (archiveExists) {
				try {
					const stats = fs.statSync(archivePath);
					if (stats.size === 0) {
						log(`⚠️  發現空的壓縮檔，將重新下載`, "yellow");
						fs.unlinkSync(archivePath);
						archiveExists = false;
					} else {
						log(`✅ 找到壓縮檔: ${path.basename(archivePath)} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`, "green");
					}
				} catch (error) {
					log(`⚠️  無法讀取壓縮檔，將重新下載`, "yellow");
					archiveExists = false;
				}
			}

			if (!archiveExists) {
				// 下載
				try {
					await downloadFile(downloadUrl, archivePath);
				} catch (error) {
					// 如果下載失敗，再次檢查是否有手動下載的檔案（可能在下載過程中放置）
					const retryFiles = fs.readdirSync(POSTGRES_DIR).filter((file) => {
						return file.endsWith(".tar.gz") && file.includes(targetTriple) && file.startsWith("postgresql-");
					});

					if (retryFiles.length > 0) {
						archivePath = path.join(POSTGRES_DIR, retryFiles[0]);
						log(`✅ 發現手動下載的檔案，將使用該檔案`, "green");
					} else {
						// 如果下載失敗且沒有壓縮檔，提供手動下載說明
						const arch = os.arch();
						log(`\n❌ 自動下載失敗。請手動下載 PostgreSQL 二進制檔案：`, "red");
						console.log(`\n📥 手動下載步驟（開源版本，無需登入）：`);
						console.log(`1. 訪問: https://github.com/theseus-rs/postgresql-binaries/releases`);
						console.log(`2. 找到可用版本（例如 v16.11.0、v16.10.0 等）`);
						console.log(`3. 下載對應平台的檔案:`);
						console.log(`   平台: ${platform} ${arch}`);
						console.log(`   目標標識符: ${targetTriple}`);
						console.log(`   檔案名稱格式: postgresql-<版本>-${targetTriple}.tar.gz`);
						console.log(`   例如: postgresql-16.11.0-${targetTriple}.tar.gz`);
						console.log(`4. 將檔案放置到: ${POSTGRES_DIR}/`);
						console.log(`5. 重新執行此腳本: npm run postgres:download\n`);
						throw error;
					}
				}
			}

			// 解壓縮
			extractArchive(archivePath, extractCommand, platform);
		}

		// 初始化資料庫
		initDatabase();

		// 啟動 PostgreSQL
		await startPostgreSQL();

		// 設定資料庫和使用者
		setupDatabase();
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
