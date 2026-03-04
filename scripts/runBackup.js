/**
 * 執行完整備份（environment_readings、alerts、people_counting、vehicle_access 等）
 * 用法: npm run backup:run 或 node scripts/runBackup.js
 */

require("../src/config");
const { runBackup } = require("../src/services/backup/backupScheduler");
const path = require("path");

function formatResult(key, r) {
  if (key === "deletedFiles") return null;
  if (typeof r === "number") return `結案 ${r} 筆`;
  const msg = r?.message ?? (r?.count != null ? `備份 ${r.count} 筆` : r?.error ?? "－");
  const file = r?.files?.csv ? path.relative(process.cwd(), r.files.csv) : "";
  return `${msg}${file ? ` → ${file}` : ""}`;
}

async function main() {
  console.log("[backup] 開始執行完整備份...");
  try {
    const results = await runBackup();
    console.log("\n[backup] 完成");
    for (const [key, r] of Object.entries(results)) {
      const line = formatResult(key, r);
      if (line != null) console.log(`  ${key}: ${line}`);
    }
    process.exit(0);
  } catch (err) {
    console.error("[backup] 失敗:", err.message);
    process.exit(1);
  }
}

main();
