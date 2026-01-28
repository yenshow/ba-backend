#!/usr/bin/env node

/**
 * 跨平台啟動可攜式 PostgreSQL
 * 支援：macOS、Windows、Linux
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
  BIN_DIR,
  DATA_DIR,
  LOG_DIR,
  binExtension,
  getBinPath,
  getPostgresPort,
  isPostgresDownloaded,
  isDatabaseInitialized,
} = require("./postgres-common");

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
const psqlPath = getBinPath("psql");

// 讀取實際配置的埠號
const port = getPostgresPort();

// 獲取當前使用者名稱（initdb 建立的預設超級使用者）
const currentUser = require("os").userInfo().username;

// 驗證 PostgreSQL 連線的輔助函數
function verifyConnection() {
  try {
    execSync(
      `"${psqlPath}" -U "${currentUser}" -d postgres -p ${port} -c "SELECT 1;"`,
      {
        stdio: "pipe",
        shell: process.platform === "win32" ? true : false,
      }
    );
    return true;
  } catch (error) {
    return false;
  }
}

// 等待 PostgreSQL 啟動並驗證連線的函數（同步版本）
function waitForPostgreSQL(maxAttempts = 15, delay = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (verifyConnection()) {
      return true;
    }
    
    if (attempt < maxAttempts) {
      // 等待後重試
      const startTime = Date.now();
      while (Date.now() - startTime < delay) {
        // 簡單的同步等待
      }
    } else {
      throw new Error(
        `PostgreSQL 在 ${maxAttempts} 次嘗試後仍無法連線。請檢查日誌: ${path.join(LOG_DIR, "postgres.log")}`
      );
    }
  }
}

try {
  // 檢查是否已在運行
  execSync(`"${pgCtlPath}" -D "${DATA_DIR}" status`, {
    stdio: "pipe",
    shell: process.platform === "win32" ? true : false,
  });
  console.log(`✅ PostgreSQL 已在運行 (埠號: ${port})`);
  
  // 驗證連線
  if (verifyConnection()) {
    console.log(`✅ PostgreSQL 連線驗證成功`);
  } else {
    console.warn(`⚠️  PostgreSQL 在運行但無法連線，可能需要重新啟動`);
  }
} catch (error) {
  // 未運行，啟動
  console.log(`🚀 啟動 PostgreSQL (埠號: ${port})...`);

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const logFile = path.join(LOG_DIR, "postgres.log");

  try {
    execSync(`"${pgCtlPath}" -D "${DATA_DIR}" -l "${logFile}" start`, {
      stdio: "inherit",
      shell: process.platform === "win32" ? true : false,
    });
    
    // 等待並驗證 PostgreSQL 啟動（同步等待）
    console.log("⏳ 等待 PostgreSQL 啟動...");
    try {
      waitForPostgreSQL(15, 1000);
      console.log(`✅ PostgreSQL 已啟動並可連線 (埠號: ${port})`);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      // 讀取日誌中的錯誤
      if (fs.existsSync(logFile)) {
        const logContent = fs.readFileSync(logFile, "utf8");
        const errors = logContent
          .split("\n")
          .filter((line) => line.includes("FATAL") || line.includes("ERROR"))
          .slice(-5);
        if (errors.length > 0) {
          console.error("\n最近的錯誤日誌:");
          errors.forEach((line) => console.error(`  ${line}`));
        }
      }
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ 啟動失敗: ${error.message}`);
    // 讀取日誌
    if (fs.existsSync(logFile)) {
      const logContent = fs.readFileSync(logFile, "utf8");
      const lastError = logContent
        .split("\n")
        .filter((line) => line.includes("FATAL") || line.includes("ERROR"))
        .slice(-3)
        .join("\n");
      if (lastError) {
        console.error(`\n日誌錯誤:\n${lastError}`);
      }
    }
    process.exit(1);
  }
}
