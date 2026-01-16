/**
 * 主要資料備份腳本
 * 使用統一備份服務進行備份
 */

const backupService = require("../src/services/backup/backupService");
const backupConfig = require("../src/services/backup/backupConfig");
const db = require("../src/database/db");

// 主函數
async function main() {
  const args = process.argv.slice(2);

  // 解析參數
  let daysToKeep = 30; // 預設保留 30 天
  let backupOnly = false; // 是否只備份不刪除

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
用法: node scripts/backupData.js [選項]

選項:
  --days <數字>     保留天數（預設: 30）
  --backup-only     只備份，不刪除資料
  --help, -h        顯示此說明

範例:
  node scripts/backupData.js --days 30
  node scripts/backupData.js --days 90 --backup-only
    `);
    process.exit(0);
  }

  const daysIndex = args.indexOf("--days");
  if (daysIndex !== -1 && args[daysIndex + 1]) {
    daysToKeep = parseInt(args[daysIndex + 1], 10);
    if (isNaN(daysToKeep) || daysToKeep < 0) {
      console.error("❌ 錯誤: --days 參數必須是正整數");
      process.exit(1);
    }
  }

  if (args.includes("--backup-only")) {
    backupOnly = true;
  }

  const beforeDate = new Date();
  beforeDate.setDate(beforeDate.getDate() - daysToKeep);

  console.log("=".repeat(60));
  console.log("📦 資料備份工具");
  console.log("=".repeat(60));
  console.log(`📅 備份 ${daysToKeep} 天前的資料（${beforeDate.toISOString().split("T")[0]} 之前）`);
  console.log(`📁 備份目錄: ${backupConfig.directories.root}`);
  if (backupOnly) {
    console.log("⚠️  模式: 只備份，不刪除資料");
  }
  console.log("=".repeat(60));

  try {
    // 測試連線
    const connected = await db.testConnection();
    if (!connected) {
      console.error("❌ 資料庫連線失敗");
      process.exit(1);
    }

    // 使用統一備份服務備份多個表
    const deleteAfterBackup = !backupOnly;
    const results = await backupService.backupMultiple({
      tables: [
        {
          tableName: "device_data_logs",
          query: "SELECT * FROM device_data_logs WHERE recorded_at < $1 ORDER BY recorded_at ASC",
          params: [beforeDate],
          deleteQuery: "DELETE FROM device_data_logs WHERE recorded_at < $1",
          deleteParams: [beforeDate],
          category: "deviceLogs",
          formats: backupConfig.formats.deviceDataLogs,
          deleteAfterBackup,
        },
        {
          tableName: "alerts",
          query: "SELECT * FROM alerts WHERE status = $1 AND resolved_at < $2 ORDER BY resolved_at ASC",
          params: ["resolved", beforeDate],
          deleteQuery: "DELETE FROM alerts WHERE status = $1 AND resolved_at < $2",
          deleteParams: ["resolved", beforeDate],
          category: "alerts",
          formats: backupConfig.formats.alerts,
          deleteAfterBackup,
        },
      ],
      compress: backupConfig.compression.enabled,
    });

    // 顯示結果
    console.log("\n" + "=".repeat(60));
    console.log("📊 備份結果");
    console.log("=".repeat(60));

    results.success.forEach((result) => {
      console.log(`\n📦 ${result.tableName}:`);
      console.log(`   📊 備份記錄數: ${result.count}`);
      if (result.deletedCount > 0) {
        console.log(`   🗑️  刪除記錄數: ${result.deletedCount}`);
      }
      if (result.files) {
        Object.entries(result.files).forEach(([format, filepath]) => {
          if (filepath) {
            console.log(`   ✅ ${format.toUpperCase()} 備份: ${require("path").basename(filepath)}`);
          }
        });
      }
    });

    if (results.failed.length > 0) {
      console.log("\n❌ 失敗的備份:");
      results.failed.forEach((failure) => {
        console.log(`   - ${failure.tableName}: ${failure.error}`);
      });
    }

    console.log("\n" + "=".repeat(60));
    console.log(`📈 總計: 備份 ${results.totalCount} 筆記錄`);
    if (results.totalDeleted > 0) {
      console.log(`🗑️  總計: 刪除 ${results.totalDeleted} 筆記錄`);
    }
    console.log("=".repeat(60));

    if (results.failed.length === 0) {
      console.log("\n🎉 備份完成！");
      console.log(`📁 備份檔案位置: ${backupConfig.directories.root}`);
    } else {
      console.log("\n⚠️  備份完成，但有部分失敗");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ 備份過程發生錯誤:", error.message);
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
  main,
};
