#!/usr/bin/env node
/**
 * 精靈①／②用的手動 postmaster（非 SCM）。
 * 若已登錄 SCM 服務，請改由 postgres-windows-service.js start，勿與此搶 DATA_DIR。
 *
 *   node scripts/portable-postgres.js start
 *   node scripts/portable-postgres.js stop
 */
const {
  startPortablePostgres,
  stopPortablePostgres,
} = require("./start-portable-postgres-lib");

const command = String(process.argv[2] || "")
  .trim()
  .toLowerCase();

const run = () => {
  if (command === "start") {
    startPortablePostgres();
    return;
  }
  if (command === "stop") {
    stopPortablePostgres();
    return;
  }
  console.error(
    "Usage: portable-postgres.js <start|stop>\n" +
      "  start  ① 已完成但 DB 未聽時，② 前短暫啟動\n" +
      "  stop   ② 成功後停止手動 postmaster，交由 SCM 接管",
  );
  process.exit(1);
};

try {
  run();
  process.exit(0);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
