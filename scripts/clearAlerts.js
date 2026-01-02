const fs = require("fs");
const path = require("path");
const db = require("../src/database/db");

/**
 * 清除警示紀錄腳本
 *
 * 此腳本用於清除所有警示紀錄和錯誤追蹤紀錄
 *
 * ⚠️ 警告：執行此腳本前請務必備份資料庫！
 */

const BACKUP_DIR = path.join(__dirname, "../backups/alerts");

// 確保備份目錄存在
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// 格式化日期為檔案名稱
function formatDateForFilename(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

// 備份警示紀錄
async function backupAlerts(alerts) {
  if (alerts.length === 0) {
    console.log("   ℹ️  沒有需要備份的警示紀錄");
    return null;
  }

  const timestamp = formatDateForFilename(new Date());
  const filename = `alerts_backup_${timestamp}.json`;
  const filepath = path.join(BACKUP_DIR, filename);

  const jsonData = JSON.stringify(alerts, null, 2);
  fs.writeFileSync(filepath, jsonData, "utf8");

  console.log(
    `   ✅ 已備份 ${alerts.length} 筆警示紀錄到 ${path.basename(filepath)}`
  );
  return filepath;
}

// 清除所有警示紀錄
async function clearAllAlerts() {
  try {
    const result = await db.query("DELETE FROM alerts RETURNING id");
    return result.length;
  } catch (error) {
    console.error("   ❌ 清除警示紀錄失敗:", error.message);
    throw error;
  }
}

// 清除錯誤追蹤紀錄
async function clearErrorTracking() {
  try {
    const result = await db.query("DELETE FROM error_tracking RETURNING id");
    return result.length;
  } catch (error) {
    console.error("   ❌ 清除錯誤追蹤紀錄失敗:", error.message);
    throw error;
  }
}

// 主函數
async function main() {
  const args = process.argv.slice(2);

  // 解析參數
  let clearTracking = false;
  let backup = true;
  let confirm = false;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
用法: node scripts/clearAlerts.js [選項]

選項:
  --clear-tracking      同時清除錯誤追蹤表（error_tracking）
  --no-backup           不備份警示紀錄
  --confirm             確認執行（必須提供此參數才會實際刪除）
  --help, -h            顯示此說明

範例:
  # 預覽模式（不會實際刪除）
  node scripts/clearAlerts.js

  # 清除所有警示紀錄（實際刪除）
  node scripts/clearAlerts.js --confirm

  # 清除所有警示紀錄和錯誤追蹤表（實際刪除）
  node scripts/clearAlerts.js --clear-tracking --confirm
		`);
    process.exit(0);
  }

  if (args.includes("--clear-tracking")) {
    clearTracking = true;
  }

  if (args.includes("--no-backup")) {
    backup = false;
  }

  if (args.includes("--confirm")) {
    confirm = true;
  }

  console.log("=".repeat(60));
  console.log("🗑️  清除警示紀錄工具");
  console.log("=".repeat(60));
  console.log("⚠️  將清除所有警示紀錄");
  if (clearTracking) {
    console.log("⚠️  將同時清除錯誤追蹤表（error_tracking）");
  }
  console.log(`📁 備份目錄: ${BACKUP_DIR}`);
  console.log(`🔒 確認執行: ${confirm ? "是" : "否（僅預覽）"}`);
  console.log("=".repeat(60));

  try {
    // 測試連線
    const connected = await db.testConnection();
    if (!connected) {
      console.error("❌ 資料庫連線失敗");
      process.exit(1);
    }

    // 取得警示紀錄數量
    console.log("\n📊 檢查警示紀錄...");
    const alertsCount = await db.query("SELECT COUNT(*) as count FROM alerts");
    const alertsTotal = parseInt(alertsCount[0]?.count || 0);
    console.log(`   alerts 表: ${alertsTotal} 筆`);

    // 取得錯誤追蹤紀錄數量
    let trackingTotal = 0;
    if (clearTracking) {
      const trackingCount = await db.query(
        "SELECT COUNT(*) as count FROM error_tracking"
      );
      trackingTotal = parseInt(trackingCount[0]?.count || 0);
      console.log(`   error_tracking 表: ${trackingTotal} 筆`);
    }

    if (alertsTotal === 0 && trackingTotal === 0) {
      console.log("\n✅ 沒有需要清除的紀錄");
      await db.close();
      process.exit(0);
    }

    // 備份警示紀錄
    if (backup && alertsTotal > 0) {
      console.log("\n📦 備份警示紀錄...");
      const allAlerts = await db.query(
        "SELECT * FROM alerts ORDER BY created_at ASC"
      );
      await backupAlerts(allAlerts);
    }

    // 如果沒有確認，只預覽
    if (!confirm) {
      console.log("\n⚠️  這是預覽模式，不會實際刪除資料");
      console.log("   如果要實際刪除，請加上 --confirm 參數");
      if (alertsTotal > 0) {
        console.log(`\n   將清除 ${alertsTotal} 筆警示紀錄`);
      }
      if (clearTracking && trackingTotal > 0) {
        console.log(`   將清除 ${trackingTotal} 筆錯誤追蹤紀錄`);
      }
      await db.close();
      process.exit(0);
    }

    // 實際清除警示紀錄
    if (alertsTotal > 0) {
      console.log("\n🗑️  清除警示紀錄...");
      const deletedCount = await clearAllAlerts();
      console.log(`   ✅ 已清除 ${deletedCount} 筆警示紀錄`);
    }

    // 清除錯誤追蹤表
    if (clearTracking) {
      console.log("\n🗑️  清除錯誤追蹤表...");
      const deletedTrackingCount = await clearErrorTracking();
      console.log(`   ✅ 已清除 ${deletedTrackingCount} 筆錯誤追蹤紀錄`);
    }

    console.log("\n🎉 清除完成！");
    if (backup && alertsTotal > 0) {
      console.log(`📁 備份檔案位置: ${BACKUP_DIR}`);
    }
  } catch (error) {
    console.error("\n❌ 清除過程發生錯誤:", error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// 如果直接執行此腳本
if (require.main === module) {
  main();
}

module.exports = {
  clearAllAlerts,
  clearErrorTracking,
};
