const db = require("../src/database/db");
const { backupDeviceDataLogs, backupDeviceAlerts } = require("./backupData");

// 清理舊資料（先備份後刪除）
async function cleanupOldData(daysToKeep = 30) {
	const beforeDate = new Date();
	beforeDate.setDate(beforeDate.getDate() - daysToKeep);

	console.log("=".repeat(60));
	console.log("🧹 資料清理工具");
	console.log("=".repeat(60));
	console.log(`📅 清理 ${daysToKeep} 天前的資料（${beforeDate.toISOString().split("T")[0]} 之前）`);
	console.log("=".repeat(60));

	try {
		// 測試連線
		const connected = await db.testConnection();
		if (!connected) {
			console.error("❌ 資料庫連線失敗");
			process.exit(1);
		}

		// 先備份
		console.log("\n📦 步驟 1: 備份資料...");
		const logsBackup = await backupDeviceDataLogs(beforeDate);
		const alertsBackup = await backupDeviceAlerts(beforeDate);

		// 確認備份成功
		if (logsBackup.count > 0 && (!logsBackup.json || !logsBackup.csv)) {
			console.error("❌ device_data_logs 備份失敗，中止刪除");
			process.exit(1);
		}

		if (alertsBackup.count > 0 && (!alertsBackup.json || !alertsBackup.csv)) {
			console.error("❌ device_alerts 備份失敗，中止刪除");
			process.exit(1);
		}

		// 刪除已備份的資料
		console.log("\n🗑️  步驟 2: 刪除舊資料...");

		if (logsBackup.count > 0) {
			console.log(`   刪除 ${logsBackup.count} 筆 device_data_logs...`);
			const result = await db.query("DELETE FROM device_data_logs WHERE recorded_at < ?", [beforeDate]);
			console.log(`   ✅ 已刪除 ${result.rowCount} 筆記錄`);
		} else {
			console.log("   ℹ️  沒有需要刪除的 device_data_logs");
		}

		if (alertsBackup.count > 0) {
			console.log(`   刪除 ${alertsBackup.count} 筆 device_alerts...`);
			const result = await db.query("DELETE FROM device_alerts WHERE resolved = TRUE AND created_at < ?", [beforeDate]);
			console.log(`   ✅ 已刪除 ${result.rowCount} 筆記錄`);
		} else {
			console.log("   ℹ️  沒有需要刪除的 device_alerts");
		}

		console.log("\n🎉 清理完成！");
		console.log(`📁 備份檔案已儲存至 backups/ 目錄`);
	} catch (error) {
		console.error("\n❌ 清理過程發生錯誤:", error.message);
		console.error(error);
		process.exit(1);
	} finally {
		await db.close();
	}
}

// 主函數
async function main() {
	const args = process.argv.slice(2);

	let daysToKeep = 30; // 預設保留 30 天

	if (args.includes("--help") || args.includes("-h")) {
		console.log(`
用法: node scripts/cleanupOldData.js [選項]

選項:
  --days <數字>     保留天數（預設: 30）
  --help, -h        顯示此說明

說明:
  此腳本會先備份舊資料（JSON 和 CSV 格式），然後再刪除。
  確保資料安全，避免誤刪。

範例:
  node scripts/cleanupOldData.js --days 30
  node scripts/cleanupOldData.js --days 90
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

	await cleanupOldData(daysToKeep);
}

// 如果直接執行此腳本
if (require.main === module) {
	main();
}

module.exports = { cleanupOldData };
