const fs = require("fs");
const path = require("path");
const db = require("../src/database/db");
const config = require("../src/config");

// 建立備份目錄
const BACKUP_DIR = path.join(process.cwd(), "backups");
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

// 匯出資料為 JSON
async function exportDataToJSON(tableName, data) {
	const timestamp = formatDateForFilename(new Date());
	const filename = `${tableName}_${timestamp}.json`;
	const filepath = path.join(BACKUP_DIR, filename);

	const jsonData = JSON.stringify(data, null, 2);
	fs.writeFileSync(filepath, jsonData, "utf8");

	return filepath;
}

// 匯出資料為 CSV
async function exportDataToCSV(tableName, data) {
	if (data.length === 0) {
		console.log(`⚠️  ${tableName} 沒有資料需要備份`);
		return null;
	}

	const timestamp = formatDateForFilename(new Date());
	const filename = `${tableName}_${timestamp}.csv`;
	const filepath = path.join(BACKUP_DIR, filename);

	// 取得欄位名稱
	const headers = Object.keys(data[0]);

	// 建立 CSV 內容
	let csvContent = headers.join(",") + "\n";

	data.forEach((row) => {
		const values = headers.map((header) => {
			const value = row[header];
			// 處理 JSON 欄位和特殊字符
			if (value === null || value === undefined) {
				return "";
			}
			if (typeof value === "object") {
				return JSON.stringify(value).replace(/"/g, '""');
			}
			return String(value).replace(/"/g, '""').replace(/,/g, ";");
		});
		csvContent += values.map((v) => `"${v}"`).join(",") + "\n";
	});

	fs.writeFileSync(filepath, csvContent, "utf8");

	return filepath;
}

// 備份 device_data_logs
async function backupDeviceDataLogs(beforeDate) {
	console.log("\n📦 備份 device_data_logs...");

	const logs = await db.query("SELECT * FROM device_data_logs WHERE recorded_at < ? ORDER BY recorded_at ASC", [beforeDate]);

	if (logs.length === 0) {
		console.log("   ℹ️  沒有需要備份的資料");
		return { json: null, csv: null, count: 0 };
	}

	console.log(`   📊 找到 ${logs.length} 筆記錄`);

	const jsonPath = await exportDataToJSON("device_data_logs", logs);
	const csvPath = await exportDataToCSV("device_data_logs", logs);

	console.log(`   ✅ JSON 備份: ${path.basename(jsonPath)}`);
	console.log(`   ✅ CSV 備份: ${path.basename(csvPath)}`);

	return { json: jsonPath, csv: csvPath, count: logs.length };
}

// 備份 device_alerts
async function backupDeviceAlerts(beforeDate) {
	console.log("\n📦 備份 device_alerts...");

	const alerts = await db.query("SELECT * FROM device_alerts WHERE resolved = TRUE AND created_at < ? ORDER BY created_at ASC", [beforeDate]);

	if (alerts.length === 0) {
		console.log("   ℹ️  沒有需要備份的資料");
		return { json: null, csv: null, count: 0 };
	}

	console.log(`   📊 找到 ${alerts.length} 筆記錄`);

	const jsonPath = await exportDataToJSON("device_alerts", alerts);
	const csvPath = await exportDataToCSV("device_alerts", alerts);

	console.log(`   ✅ JSON 備份: ${path.basename(jsonPath)}`);
	console.log(`   ✅ CSV 備份: ${path.basename(csvPath)}`);

	return { json: jsonPath, csv: csvPath, count: alerts.length };
}

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
	console.log(`📁 備份目錄: ${BACKUP_DIR}`);
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

		// 備份 device_data_logs
		const logsBackup = await backupDeviceDataLogs(beforeDate);

		// 備份 device_alerts
		const alertsBackup = await backupDeviceAlerts(beforeDate);

		// 如果只備份，不刪除
		if (backupOnly) {
			console.log("\n✅ 備份完成（未刪除資料）");
			await db.close();
			process.exit(0);
		}

		// 刪除已備份的資料
		if (logsBackup.count > 0) {
			console.log("\n🗑️  刪除舊的 device_data_logs...");
			const result = await db.query("DELETE FROM device_data_logs WHERE recorded_at < ?", [beforeDate]);
			console.log(`   ✅ 已刪除 ${result.affectedRows} 筆記錄`);
		}

		if (alertsBackup.count > 0) {
			console.log("\n🗑️  刪除已解決的舊 device_alerts...");
			const result = await db.query("DELETE FROM device_alerts WHERE resolved = TRUE AND created_at < ?", [beforeDate]);
			console.log(`   ✅ 已刪除 ${result.affectedRows} 筆記錄`);
		}

		console.log("\n🎉 備份與清理完成！");
		console.log(`📁 備份檔案位置: ${BACKUP_DIR}`);
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
	backupDeviceDataLogs,
	backupDeviceAlerts,
	exportDataToJSON,
	exportDataToCSV
};
