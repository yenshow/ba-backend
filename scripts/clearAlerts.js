const db = require("../src/database/db");

/**
 * 清除警示紀錄腳本
 *
 * 此腳本用於清除警示紀錄、錯誤追蹤紀錄和相關歷史紀錄
 *
 * ⚠️ 警告：執行此腳本前請務必備份資料庫！
 *
 * 功能：
 * - 支援按狀態篩選清除（只清除已解決的警報）
 * - 使用事務確保資料一致性
 */

// 取得警示歷史紀錄數量（用於統計）
async function getAlertHistoryCount(alertIds = null) {
  try {
    if (alertIds && alertIds.length > 0) {
      const placeholders = alertIds.map((_, i) => `$${i + 1}`).join(", ");
      const result = await db.query(
        `SELECT COUNT(*) as count FROM alert_history WHERE alert_id IN (${placeholders})`,
        alertIds
      );
      return parseInt(result[0]?.count || 0);
    } else {
      const result = await db.query(
        "SELECT COUNT(*) as count FROM alert_history"
      );
      return parseInt(result[0]?.count || 0);
    }
  } catch (error) {
    console.error("   ⚠️  取得警示歷史紀錄數量失敗:", error.message);
    return 0;
  }
}

// 主函數
async function main() {
  const args = process.argv.slice(2);

  // 解析參數
  let clearTracking = false;
  let statusFilter = null;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
用法: node scripts/clearAlerts.js [選項]

選項:
  --clear-tracking      同時清除錯誤追蹤表（error_tracking）
  --status <status>     只清除特定狀態的警報（active, resolved, ignored）
  --help, -h            顯示此說明

範例:
  # 清除所有警示紀錄
  node scripts/clearAlerts.js

  # 只清除已解決的警示紀錄
  node scripts/clearAlerts.js --status resolved

  # 清除所有警示紀錄和錯誤追蹤表
  node scripts/clearAlerts.js --clear-tracking
		`);
    process.exit(0);
  }

  if (args.includes("--clear-tracking")) {
    clearTracking = true;
  }

  // 解析狀態篩選
  const statusIndex = args.indexOf("--status");
  if (statusIndex !== -1 && args[statusIndex + 1]) {
    const status = args[statusIndex + 1].toLowerCase();
    if (["active", "resolved", "ignored"].includes(status)) {
      statusFilter = status;
    } else {
      console.error(
        `❌ 無效的狀態: ${status}。支援的狀態: active, resolved, ignored`
      );
      process.exit(1);
    }
  }

  console.log("=".repeat(60));
  console.log("🗑️  清除警示紀錄工具");
  console.log("=".repeat(60));
  if (statusFilter) {
    console.log(`⚠️  將清除狀態為 "${statusFilter}" 的警示紀錄`);
  } else {
    console.log("⚠️  將清除所有警示紀錄");
  }
  if (clearTracking) {
    console.log("⚠️  將同時清除錯誤追蹤表（error_tracking）");
  }
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
    let alertsCountQuery = "SELECT COUNT(*) as count FROM alerts";
    const alertsCountParams = [];
    if (statusFilter) {
      alertsCountQuery += " WHERE status = ?";
      alertsCountParams.push(statusFilter);
    }
    const alertsCount = await db.query(alertsCountQuery, alertsCountParams);
    const alertsTotal = parseInt(alertsCount[0]?.count || 0);
    console.log(
      `   alerts 表: ${alertsTotal} 筆${
        statusFilter ? ` (狀態: ${statusFilter})` : ""
      }`
    );

    // 取得警示歷史紀錄數量（如果清除所有警報，歷史記錄會因 CASCADE 自動刪除）
    let historyTotal = 0;
    if (!statusFilter) {
      historyTotal = await getAlertHistoryCount();
      if (historyTotal > 0) {
        console.log(
          `   alert_history 表: ${historyTotal} 筆（將因 CASCADE 自動刪除）`
        );
      }
    } else {
      // 如果只清除特定狀態的警報，需要先取得這些警報的 ID
      let alertsQuery = "SELECT id FROM alerts WHERE status = ?";
      const alertIds = await db.query(alertsQuery, [statusFilter]);
      if (alertIds.length > 0) {
        const ids = alertIds.map((a) => a.id);
        historyTotal = await getAlertHistoryCount(ids);
        if (historyTotal > 0) {
          console.log(
            `   alert_history 表: ${historyTotal} 筆（將因 CASCADE 自動刪除）`
          );
        }
      }
    }

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

    // 使用事務確保資料一致性
    console.log("\n🗑️  開始清除（使用事務確保一致性）...");
    await db.transaction(async (txQuery) => {
      // 實際清除警示紀錄
      if (alertsTotal > 0) {
        console.log("   正在清除警示紀錄...");
        let deleteQuery = "DELETE FROM alerts";
        const deleteParams = [];
        if (statusFilter) {
          deleteQuery += " WHERE status = ?";
          deleteParams.push(statusFilter);
        }
        deleteQuery += " RETURNING id";
        const deletedResult = await txQuery(deleteQuery, deleteParams);
        const deletedCount = deletedResult.length;
        console.log(`   ✅ 已清除 ${deletedCount} 筆警示紀錄`);
        if (historyTotal > 0) {
          console.log(
            `   ✅ 已自動清除 ${historyTotal} 筆相關的警示歷史紀錄（CASCADE）`
          );
        }
      }

      // 清除錯誤追蹤表
      if (clearTracking && trackingTotal > 0) {
        console.log("   正在清除錯誤追蹤表...");
        const deletedResult = await txQuery(
          "DELETE FROM error_tracking RETURNING id"
        );
        const deletedTrackingCount = deletedResult.length;
        console.log(`   ✅ 已清除 ${deletedTrackingCount} 筆錯誤追蹤紀錄`);
      }
    });

    console.log("\n🎉 清除完成！");
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

// 導出函數供其他模組使用
async function clearAlerts(statusFilter = null) {
  let query = "DELETE FROM alerts";
  const params = [];
  if (statusFilter) {
    query += " WHERE status = ?";
    params.push(statusFilter);
  }
  query += " RETURNING id";
  const result = await db.query(query, params);
  return result.length;
}

async function clearErrorTracking() {
  const result = await db.query("DELETE FROM error_tracking RETURNING id");
  return result.length;
}

// 向後兼容的函數
async function clearAllAlerts() {
  return await clearAlerts(null);
}

module.exports = {
  clearAllAlerts,
  clearErrorTracking,
  clearAlerts,
  getAlertHistoryCount,
};
