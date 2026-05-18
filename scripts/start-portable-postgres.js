#!/usr/bin/env node

/**
 * 啟動可攜式 PostgreSQL（Windows）
 */

const {
  isPostgresDownloaded,
  isDatabaseInitialized,
} = require("./postgres-common");
const { startPortablePostgres } = require("./start-portable-postgres-lib");

if (!isPostgresDownloaded()) {
  console.error("❌ PostgreSQL 尚未安裝");
  console.error("請先執行: npm run postgres:download");
  process.exit(1);
}

if (!isDatabaseInitialized()) {
  console.error("❌ 資料庫尚未初始化");
  console.error("請先執行: npm run postgres:download");
  process.exit(1);
}

try {
  startPortablePostgres();
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
