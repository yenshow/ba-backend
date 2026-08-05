#!/usr/bin/env node
/**
 * 停止精靈①／②留下的手動 postmaster（交由 SCM 接管前呼叫）。
 */
const { stopPortablePostgres } = require("./start-portable-postgres-lib");

try {
  stopPortablePostgres();
  process.exit(0);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
