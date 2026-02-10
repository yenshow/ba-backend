/**
 * 執行三種資料備份（environment_readings、alerts、people_counting）
 * 用法: npm run backup:run 或 node scripts/runBackup.js
 */

require("../src/config");
const { runBackup } = require("../src/services/backup/backupScheduler");
const path = require("path");

async function main() {
  console.log("[backup] 開始執行完整備份...");
  try {
    const results = await runBackup();
    console.log("\n[backup] 完成");
    for (const [key, r] of Object.entries(results)) {
      if (key === "deletedFiles") continue;
      const msg = r?.message || (r?.count != null ? `備份 ${r.count} 筆` : r?.error || "-");
      const file = r?.files?.csv ? path.relative(process.cwd(), r.files.csv) : "";
      console.log(`  ${key}: ${msg}${file ? ` → ${file}` : ""}`);
    }
    process.exit(0);
  } catch (err) {
    console.error("[backup] 失敗:", err.message);
    process.exit(1);
  }
}

main();
