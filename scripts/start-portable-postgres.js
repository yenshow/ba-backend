#!/usr/bin/env node
/**
 * 啟動精靈①／②用的手動 postmaster（① 已完成但 DB 未聽時，② 前呼叫）。
 * 若已登錄 SCM 服務，請改由 postgres-windows-service.js start，勿與此搶 DATA_DIR。
 */
const { startPortablePostgres } = require("./start-portable-postgres-lib");

try {
  startPortablePostgres();
  process.exit(0);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
