#!/usr/bin/env node

/**
 * Windows 離線安裝可攜式 PostgreSQL（解壓內建 tar.gz → initdb → 啟動 → 建立 DB/使用者）
 * 安裝包須含：postgres/postgresql-16.11.0-x86_64-pc-windows-msvc.tar.gz
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  POSTGRES_DIR,
  BIN_DIR,
  DATA_DIR,
  LOG_DIR,
  binExtension,
  PG_OFFLINE_ARCHIVE_NAME,
  getPostgresqlConfPath,
  getPostgresPort,
  getOfflineArchivePath,
  isPostgresDownloaded,
} = require("./postgres-common");
const { log, execWithUtf8OnWindows } = require("./postgres-exec-windows");
const {
  startPortablePostgres,
  verifyPsqlReady,
  PSQL_HOST,
  PSQL_COMMON_ARGS,
} = require("./start-portable-postgres-lib");

function ensureDirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function assertOfflineArchive() {
  const archivePath = getOfflineArchivePath();
  if (!fs.existsSync(archivePath)) {
    throw new Error(
      `找不到離線安裝檔：${archivePath}\n` +
        `請確認安裝包內含 ${PG_OFFLINE_ARCHIVE_NAME}（與打包腳本 staging 一致）。`,
    );
  }
  const stats = fs.statSync(archivePath);
  if (stats.size < 1024) {
    throw new Error(`離線安裝檔過小或損壞：${archivePath}`);
  }
  return archivePath;
}

function extractArchive(archivePath) {
  log(`📦 解壓縮 ${path.basename(archivePath)}...`, "yellow");

  try {
    execWithUtf8OnWindows(`tar -xzf "${archivePath}" -C "${POSTGRES_DIR}"`, {
      stdio: "inherit",
    });
  } catch (error) {
    throw new Error(
      `解壓縮失敗（請確認 Windows 內建 tar 可用）：${error.message}`,
    );
  }

  const extractedDirs = fs.readdirSync(POSTGRES_DIR).filter((item) => {
    const itemPath = path.join(POSTGRES_DIR, item);
    try {
      const stat = fs.statSync(itemPath);
      if (!stat.isDirectory()) return false;
      if (item === "data" || item === "logs") return false;
      const binPath = path.join(itemPath, "bin");
      return (
        fs.existsSync(binPath) ||
        item.startsWith("pgsql") ||
        item.toLowerCase().includes("postgresql")
      );
    } catch {
      return false;
    }
  });

  if (extractedDirs.length > 0) {
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

    fs.rmSync(extractedDir, { recursive: true, force: true });
  } else if (!fs.existsSync(path.join(POSTGRES_DIR, "bin"))) {
    throw new Error(
      `解壓縮後未找到 bin 目錄。目錄內容: ${fs.readdirSync(POSTGRES_DIR).join(", ")}`,
    );
  }

  const psqlPath = path.join(BIN_DIR, `psql${binExtension}`);
  if (!fs.existsSync(psqlPath)) {
    throw new Error("解壓縮驗證失敗：找不到 psql.exe");
  }

  try {
    fs.unlinkSync(archivePath);
    log(`✅ 已清理壓縮檔`, "green");
  } catch (error) {
    log(`⚠️  無法刪除壓縮檔: ${error.message}`, "yellow");
  }

  log(`✅ PostgreSQL 二進制檔案已就緒`, "green");
}

function throwInitdbDllError(execError) {
  const errorCode = execError.status || execError.code;
  const errorOutput = (
    execError.stdout ||
    execError.stderr ||
    execError.message ||
    ""
  ).toString();

  const isDllError =
    errorCode === 3221225781 ||
    errorCode === -1073741515 ||
    errorCode === 3221226505 ||
    errorOutput.includes("0xC0000135") ||
    errorOutput.includes("STATUS_DLL_NOT_FOUND") ||
    (errorOutput.includes("DLL") && errorOutput.includes("not found")) ||
    errorOutput.includes("The specified module could not be found") ||
    errorOutput.includes("無法找到指定的模組");

  if (!isDllError) {
    throw execError;
  }

  log(`\n❌ 初始化資料庫失敗：缺少 Visual C++ 運行時庫`, "red");
  console.log(`  請確認 Inno 安裝程式已安裝 VC++ Redistributable，或手動安裝：`);
  console.log(`  https://aka.ms/vs/17/release/vc_redist.x64.exe\n`);
  throw new Error(
    "初始化資料庫失敗：缺少 Visual C++ Redistributable。請安裝後重試。",
  );
}

function initDatabase() {
  const initdbPath = path.join(BIN_DIR, `initdb${binExtension}`);

  if (fs.existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
    log(`✅ PostgreSQL 資料目錄已存在`, "green");
    return;
  }

  log(`🔧 初始化資料庫...`, "yellow");
  ensureDirSync(DATA_DIR);

  const initdbCmd = `"${initdbPath}" -D "${DATA_DIR}" --auth-local=trust --auth-host=trust`;
  try {
    execWithUtf8OnWindows(initdbCmd, { stdio: "inherit", encoding: "utf8" });
  } catch (execError) {
    throwInitdbDllError(execError);
  }

  const postgresqlConf = getPostgresqlConfPath();
  const dbPort = process.env.DB_PORT || "5432";

  let confContent = "";
  if (fs.existsSync(postgresqlConf)) {
    confContent = fs.readFileSync(postgresqlConf, "utf8");
  }

  let needsWrite = false;

  if (!confContent.includes("listen_addresses =")) {
    confContent += "\nlisten_addresses = 'localhost'\n";
    needsWrite = true;
  }

  if (confContent.match(/^port\s*=/m)) {
    confContent = confContent.replace(/^port\s*=\s*\d+/m, `port = ${dbPort}`);
    needsWrite = true;
  } else {
    confContent += `port = ${dbPort}\n`;
    needsWrite = true;
  }

  if (!confContent.includes("max_connections =")) {
    confContent += "max_connections = 100\n";
    needsWrite = true;
  }

  if (needsWrite) {
    fs.writeFileSync(postgresqlConf, confContent);
  }

  ensurePgHbaTrustRules(path.join(DATA_DIR, "pg_hba.conf"));
  log(`✅ 資料庫已初始化`, "green");
}

function ensurePgHbaTrustRules(pgHbaConfPath) {
  ensureDirSync(path.dirname(pgHbaConfPath));
  if (!fs.existsSync(pgHbaConfPath)) {
    throw new Error(`找不到 pg_hba.conf：${pgHbaConfPath}`);
  }

  const beginMarker = "# BA_SYSTEM_MANAGED_BEGIN";
  const endMarker = "# BA_SYSTEM_MANAGED_END";
  const managedBlock = [
    beginMarker,
    "local all all trust",
    "host all all 127.0.0.1/32 trust",
    "host all all ::1/128 trust",
    endMarker,
    "",
  ].join("\n");

  const original = fs.readFileSync(pgHbaConfPath, "utf8");
  let content = original.replace(/\r\n/g, "\n");

  const blockRegex = new RegExp(
    `${beginMarker}[\\s\\S]*?${endMarker}\\n?`,
    "g",
  );
  content = content.replace(blockRegex, "");

  const lines = content.split("\n");
  let insertAt = 0;
  while (insertAt < lines.length) {
    const line = lines[insertAt].trim();
    if (line === "" || line.startsWith("#")) {
      insertAt += 1;
      continue;
    }
    break;
  }

  lines.splice(insertAt, 0, managedBlock.trimEnd());
  const next = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  if (next !== content) {
    fs.writeFileSync(pgHbaConfPath, next.replace(/\n/g, os.EOL), "utf8");
  }
}

function setupDatabase() {
  log(`📝 設定資料庫和使用者...`, "yellow");

  const psqlPath = path.join(BIN_DIR, `psql${binExtension}`);
  const port = getPostgresPort();
  const currentUser = os.userInfo().username;

  verifyPsqlReady();

  const dbName = (process.env.DB_NAME || "ba_system").trim();
  const dbUser = (process.env.DB_USER || "postgres").trim();

  const dbCheckCmd = `"${psqlPath}" ${PSQL_COMMON_ARGS} -h "${PSQL_HOST}" -p ${port} -U "${currentUser}" -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '${dbName}'"`;
  const dbCheck = execWithUtf8OnWindows(dbCheckCmd, {
    encoding: "utf8",
    stdio: "pipe",
  });

  if (!dbCheck.trim()) {
    execWithUtf8OnWindows(
      `"${psqlPath}" ${PSQL_COMMON_ARGS} -h "${PSQL_HOST}" -p ${port} -U "${currentUser}" -d postgres -c "CREATE DATABASE ${dbName};"`,
      { stdio: "inherit" },
    );
  }

  const userCheckCmd = `"${psqlPath}" ${PSQL_COMMON_ARGS} -h "${PSQL_HOST}" -p ${port} -U "${currentUser}" -d postgres -tc "SELECT 1 FROM pg_user WHERE usename = '${dbUser}'"`;
  const userCheck = execWithUtf8OnWindows(userCheckCmd, {
    encoding: "utf8",
    stdio: "pipe",
  });

  if (!userCheck.trim()) {
    execWithUtf8OnWindows(
      `"${psqlPath}" ${PSQL_COMMON_ARGS} -h "${PSQL_HOST}" -p ${port} -U "${currentUser}" -d postgres -c "CREATE USER ${dbUser} WITH SUPERUSER PASSWORD 'postgres';"`,
      { stdio: "inherit" },
    );
  }

  execWithUtf8OnWindows(
    `"${psqlPath}" ${PSQL_COMMON_ARGS} -h "${PSQL_HOST}" -p ${port} -U "${currentUser}" -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${dbUser};"`,
    { stdio: "inherit" },
  );
  execWithUtf8OnWindows(
    `"${psqlPath}" ${PSQL_COMMON_ARGS} -h "${PSQL_HOST}" -p ${port} -U "${currentUser}" -d ${dbName} -c "GRANT ALL ON SCHEMA public TO ${dbUser};"`,
    { stdio: "inherit" },
  );

  log(`✅ 資料庫和使用者已設定完成`, "green");

  console.log("");
  log(`🎉 可攜式 PostgreSQL 設定完成！`, "green");
  console.log("");
  const displayPort = getPostgresPort();
  console.log("連線資訊:");
  console.log(`  Host: ${PSQL_HOST}`);
  console.log(`  Port: ${displayPort}`);
  console.log(`  Database: ${dbName}`);
  console.log(`  User: ${dbUser}`);
  console.log(`  Password: postgres`);
  console.log("");
  console.log("使用方式:");
  console.log(`  啟動: npm run postgres:start`);
  console.log(`  停止: npm run postgres:stop`);
}

async function main() {
  log(`🚀 開始設定可攜式 PostgreSQL（離線）...`, "green");

  ensureDirSync(POSTGRES_DIR);

  if (!isPostgresDownloaded()) {
    const archivePath = assertOfflineArchive();
    extractArchive(archivePath);
  } else {
    log(`✅ PostgreSQL 二進制檔案已存在`, "green");
  }

  initDatabase();
  startPortablePostgres();
  setupDatabase();
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      log(`❌ 錯誤: ${error.message}`, "red");
      process.exit(1);
    });
}

module.exports = { main };
