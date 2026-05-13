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
const dotenv = require("dotenv");

// 載入 .env 以讀取 DB_PORT 等配置
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

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
					// Windows 路徑需要正確處理，使用 shell: true
					execSync(`tar -xzf "${archivePath}" -C "${POSTGRES_DIR}"`, {
						stdio: "inherit",
						shell: true
					});
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
		// Windows 需要特殊處理路徑中的空格和特殊字元
		if (process.platform === "win32") {
			// Windows: 使用引號包裹路徑，並使用 shell: true
			const initdbCmd = `"${initdbPath}" -D "${DATA_DIR}" --auth-local=trust --auth-host=trust`;
			try {
				execSync(initdbCmd, {
					stdio: "inherit",
					shell: true,
					encoding: "utf8"
				});
			} catch (execError) {
				// 檢查是否是 DLL 缺失錯誤
				const errorCode = execError.status || execError.code;
				const errorOutput = (execError.stdout || execError.stderr || execError.message || "").toString();

				// 錯誤碼 0xC0000135 (3221225781) 或 -1073741515 表示 DLL_NOT_FOUND
				// 也檢查錯誤訊息中是否包含相關關鍵字
				const isDllError =
					errorCode === 3221225781 ||
					errorCode === -1073741515 ||
					errorCode === 3221226505 || // STATUS_ENTRYPOINT_NOT_FOUND
					errorOutput.includes("0xC0000135") ||
					errorOutput.includes("STATUS_DLL_NOT_FOUND") ||
					(errorOutput.includes("DLL") && errorOutput.includes("not found")) ||
					errorOutput.includes("The specified module could not be found") ||
					errorOutput.includes("無法找到指定的模組");

				if (isDllError) {
					log(`\n❌ 初始化資料庫失敗：缺少必要的運行時庫`, "red");
					console.log(`\n問題診斷：`);
					console.log(`  initdb.exe 執行時出現錯誤碼 ${errorCode || "未知"}`);
					if (errorCode === 3221225781 || errorCode === -1073741515) {
						console.log(`  錯誤碼 0xC0000135 表示 STATUS_DLL_NOT_FOUND`);
					}
					console.log(`  這通常是缺少必要的 DLL 或 Visual C++ 運行時庫。\n`);
					console.log(`建議的解決方案：`);
					console.log(`\n方案 1：安裝 Visual C++ Redistributable（推薦）`);
					console.log(`  1. 下載並安裝 Visual C++ Redistributable：`);
					console.log(`     https://aka.ms/vs/17/release/vc_redist.x64.exe`);
					console.log(`  2. 安裝後重新執行：`);
					console.log(`     npm run postgres:download\n`);
					console.log(`方案 2：手動執行 initdb`);
					console.log(`  在 PowerShell 中執行：`);
					console.log(`    cd postgres\\bin`);
					console.log(`    $env:PATH = "$PWD;$env:PATH"`);
					console.log(`    .\\initdb.exe -D ..\\data --auth-local=trust --auth-host=trust\n`);
					console.log(`方案 3：使用系統安裝的 PostgreSQL`);
					console.log(`  如果系統已安裝 PostgreSQL，可跳過可攜式版本，直接使用系統版本。\n`);

					throw new Error(`初始化資料庫失敗：缺少 Visual C++ Redistributable。請安裝後重試。`);
				}

				// 其他錯誤，顯示詳細訊息
				log(`\n❌ 初始化資料庫失敗`, "red");
				console.log(`錯誤碼: ${errorCode || "未知"}`);
				if (errorOutput) {
					console.log(`錯誤訊息:\n${errorOutput}`);
				}
				throw new Error(`初始化資料庫失敗: ${execError.message}`);
			}
		} else {
			// Unix-like: 直接執行
			const initdbCmd = `"${initdbPath}" -D "${DATA_DIR}" --auth-local=trust --auth-host=trust`;
			execSync(initdbCmd, {
				stdio: "inherit"
			});
		}
	} catch (error) {
		// 如果已經處理過 DLL 錯誤，直接拋出
		if (error.message.includes("Visual C++ Redistributable")) {
			throw error;
		}
		// 其他錯誤，提供一般性錯誤訊息
		throw error;
	}

	// 設定配置
	const postgresqlConf = getPostgresqlConfPath();
	// 從環境變數讀取端口，預設為 5432
	const dbPort = process.env.DB_PORT || "5432";
	
	// 讀取現有配置
	let confContent = "";
	if (fs.existsSync(postgresqlConf)) {
		confContent = fs.readFileSync(postgresqlConf, "utf8");
	}
	
	// 更新或添加配置項
	let needsWrite = false;
	
	if (!confContent.includes("listen_addresses =")) {
		confContent += "\nlisten_addresses = 'localhost'\n";
		needsWrite = true;
	}
	
	// 更新 port 配置
	if (confContent.match(/^port\s*=/m)) {
		// 如果 port 已存在，更新它
		confContent = confContent.replace(/^port\s*=\s*\d+/m, `port = ${dbPort}`);
		needsWrite = true;
	} else {
		// 如果 port 不存在，添加它
		confContent += `port = ${dbPort}\n`;
		needsWrite = true;
	}
	
	if (!confContent.includes("max_connections =")) {
		confContent += "max_connections = 100\n";
		needsWrite = true;
	}
	
	// 如果有變更，寫入檔案
	if (needsWrite) {
		fs.writeFileSync(postgresqlConf, confContent);
	}

	const pgHbaConf = path.join(DATA_DIR, "pg_hba.conf");
	// 檢查 trust 規則是否已存在，避免重複添加
	let pgHbaContent = "";
	if (fs.existsSync(pgHbaConf)) {
		pgHbaContent = fs.readFileSync(pgHbaConf, "utf8");
	}
	
	if (!pgHbaContent.includes("host all all 127.0.0.1/32 trust")) {
		fs.appendFileSync(pgHbaConf, "\nhost all all 127.0.0.1/32 trust\n");
	}
	if (!pgHbaContent.includes("host all all ::1/128 trust")) {
		fs.appendFileSync(pgHbaConf, "host all all ::1/128 trust\n");
	}

	log(`✅ 資料庫已初始化`, "green");
}

// 檢查端口是否被占用
function checkPortAvailable(port) {
	try {
		if (process.platform === "win32") {
			const result = execSync(`netstat -ano | findstr :${port}`, {
				stdio: "pipe",
				encoding: "utf8",
				shell: true
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
		// 如果命令失敗（例如沒有 lsof 或 netstat），假設端口可用
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
			shell: process.platform === "win32" ? true : false
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
		console.log(`     將 port = ${port} 改為其他端口（例如 ${port + 1}）`);
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
			shell: process.platform === "win32" ? true : false
		});
		// 等待啟動
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// 驗證是否成功啟動
		try {
			execSync(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
				stdio: "pipe",
				shell: process.platform === "win32" ? true : false
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
	const port = getPostgresPort();
	const host = "127.0.0.1";

	const sleepMs = (ms) => {
		// 同步 sleep（避免引入額外依賴；此腳本本來就以同步流程為主）
		// eslint-disable-next-line no-undef
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	};

	const waitForPsqlReady = (maxAttempts = 30, delayMs = 500) => {
		const currentUser = os.userInfo().username;
		for (let i = 1; i <= maxAttempts; i++) {
			try {
				execSync(
					`"${psqlPath}" -h "${host}" -p ${port} -U "${currentUser}" -d postgres -c "SELECT 1;"`,
					{
						encoding: "utf8",
						stdio: "pipe",
						shell: process.platform === "win32" ? true : false
					}
				);
				return;
			} catch (e) {
				if (i === maxAttempts) {
					throw new Error(
						`PostgreSQL 已啟動但仍無法連線（${host}:${port}）。請檢查 ${path.join(
							LOG_DIR,
							"postgres.log"
						)}`
					);
				}
				sleepMs(delayMs);
			}
		}
	};

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
		// Windows 上 pg_ctl start 可能回報已啟動但尚未就緒，先等到可接受連線
		waitForPsqlReady();

		// 建立資料庫
		const dbCheckCmd = `"${psqlPath}" -h "${host}" -p ${port} -U "${currentUser}" -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '${dbName}'"`;
		const dbCheck = execSync(dbCheckCmd, {
			encoding: "utf8",
			stdio: "pipe",
			shell: process.platform === "win32" ? true : false
		});

		if (!dbCheck.trim()) {
			execSync(`"${psqlPath}" -h "${host}" -p ${port} -U "${currentUser}" -d postgres -c "CREATE DATABASE ${dbName};"`, {
				stdio: "inherit",
				shell: process.platform === "win32" ? true : false
			});
		}

		// 建立使用者
		const userCheckCmd = `"${psqlPath}" -h "${host}" -p ${port} -U "${currentUser}" -d postgres -tc "SELECT 1 FROM pg_user WHERE usename = '${dbUser}'"`;
		const userCheck = execSync(userCheckCmd, {
			encoding: "utf8",
			stdio: "pipe",
			shell: process.platform === "win32" ? true : false
		});

		if (!userCheck.trim()) {
			const createUserCmd = `"${psqlPath}" -h "${host}" -p ${port} -U "${currentUser}" -d postgres -c "CREATE USER ${dbUser} WITH SUPERUSER PASSWORD 'postgres';"`;
			execSync(createUserCmd, {
				stdio: "inherit",
				shell: process.platform === "win32" ? true : false
			});
		}

		// 授予權限
		const grantDbCmd = `"${psqlPath}" -h "${host}" -p ${port} -U "${currentUser}" -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${dbUser};"`;
		execSync(grantDbCmd, {
			stdio: "inherit",
			shell: process.platform === "win32" ? true : false
		});
		const grantSchemaCmd = `"${psqlPath}" -h "${host}" -p ${port} -U "${currentUser}" -d ${dbName} -c "GRANT ALL ON SCHEMA public TO ${dbUser};"`;
		execSync(grantSchemaCmd, {
			stdio: "inherit",
			shell: process.platform === "win32" ? true : false
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
