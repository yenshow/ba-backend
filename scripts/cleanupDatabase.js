const db = require("../src/database/db");
const fs = require("fs");
const path = require("path");

/**
 * 資料庫清理腳本
 * 
 * 此腳本用於：
 * 1. 備份要移除的表的數據
 * 2. 移除多餘的表和相關約束
 * 3. 更新外鍵約束
 * 
 * ⚠️ 警告：執行此腳本前請務必備份資料庫！
 */

const BACKUP_DIR = path.join(__dirname, "../backups/cleanup");

// 確保備份目錄存在
if (!fs.existsSync(BACKUP_DIR)) {
	fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// 備份表數據
async function backupTable(tableName) {
	console.log(`\n📦 備份表: ${tableName}...`);
	try {
		const data = await db.query(`SELECT * FROM ${tableName}`);
		
		if (data.length === 0) {
			console.log(`   ℹ️  表 ${tableName} 沒有數據`);
			return { count: 0, file: null };
		}

		const jsonPath = path.join(BACKUP_DIR, `${tableName}_${Date.now()}.json`);
		fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
		
		console.log(`   ✅ 已備份 ${data.length} 筆記錄到 ${path.basename(jsonPath)}`);
		return { count: data.length, file: jsonPath };
	} catch (error) {
		if (error.message.includes("does not exist")) {
			console.log(`   ℹ️  表 ${tableName} 不存在，跳過`);
			return { count: 0, file: null };
		}
		throw error;
	}
}

// 移除外鍵約束
async function dropForeignKey(tableName, constraintName) {
	try {
		await db.query(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${constraintName}`);
		console.log(`   ✅ 已移除外鍵約束: ${constraintName}`);
	} catch (error) {
		console.warn(`   ⚠️  移除外鍵約束失敗: ${constraintName} - ${error.message}`);
	}
}

// 移除表
async function dropTable(tableName) {
	try {
		await db.query(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
		console.log(`   ✅ 已移除表: ${tableName}`);
	} catch (error) {
		console.error(`   ❌ 移除表失敗: ${tableName} - ${error.message}`);
		throw error;
	}
}

// 主清理函數
async function cleanupDatabase() {
	console.log("=".repeat(60));
	console.log("🧹 資料庫清理工具");
	console.log("=".repeat(60));
	console.log("⚠️  警告：此操作將移除多餘的表！");
	console.log("=".repeat(60));

	try {
		// 測試連線
		const connected = await db.testConnection();
		if (!connected) {
			console.error("❌ 資料庫連線失敗");
			process.exit(1);
		}

		// 步驟 1: 備份數據
		console.log("\n📦 步驟 1: 備份數據...");
		const backups = {};

		// 備份要移除的表（雖然不需要轉移資料，但備份是安全措施）
		const tablesToBackup = [
			"modbus_device_types",
			"modbus_device_models",
			"modbus_device_addresses",
			"modbus_ports"
		];

		for (const tableName of tablesToBackup) {
			backups[tableName] = await backupTable(tableName);
		}

		// 步驟 2: 移除外鍵約束
		console.log("\n🔗 步驟 2: 移除外鍵約束...");
		
		// 移除 devices 表對舊表的外鍵
		await dropForeignKey("devices", "fk_devices_model");
		await dropForeignKey("devices", "fk_devices_type");
		await dropForeignKey("devices", "fk_devices_port");

		// 步驟 3: 更新 devices 表的外鍵約束（指向新表）
		console.log("\n🔗 步驟 3: 更新外鍵約束...");
		
		// 添加新的外鍵約束（如果不存在）
		try {
			await db.query(`
				ALTER TABLE devices 
				ADD CONSTRAINT fk_devices_model_new 
				FOREIGN KEY (model_id) REFERENCES device_models(id) ON DELETE SET NULL
			`);
			console.log("   ✅ 已添加 devices -> device_models 外鍵");
		} catch (error) {
			if (error.message.includes("already exists")) {
				console.log("   ℹ️  devices -> device_models 外鍵已存在");
			} else {
				console.warn(`   ⚠️  添加外鍵失敗: ${error.message}`);
			}
		}

		try {
			await db.query(`
				ALTER TABLE devices 
				ADD CONSTRAINT fk_devices_type_new 
				FOREIGN KEY (type_id) REFERENCES device_types(id) ON DELETE RESTRICT
			`);
			console.log("   ✅ 已添加 devices -> device_types 外鍵");
		} catch (error) {
			if (error.message.includes("already exists")) {
				console.log("   ℹ️  devices -> device_types 外鍵已存在");
			} else {
				console.warn(`   ⚠️  添加外鍵失敗: ${error.message}`);
			}
		}

		// 移除 port_id 外鍵（如果不需要 modbus_ports 表）
		await dropForeignKey("devices", "fk_devices_port");

		// 步驟 4: 移除表
		console.log("\n🗑️  步驟 4: 移除多餘的表...");
		
		const tablesToRemove = [
			"modbus_device_addresses",  // 先移除沒有外鍵依賴的表
			"modbus_device_models",
			"modbus_device_types",
			"modbus_ports"
		];

		for (const tableName of tablesToRemove) {
			await dropTable(tableName);
		}

		// 步驟 5: 移除 devices 表中不需要的欄位（可選）
		console.log("\n🔧 步驟 5: 清理 devices 表欄位（可選）...");
		
		// 移除 port_id 欄位（如果不需要）
		try {
			await db.query(`ALTER TABLE devices DROP COLUMN IF EXISTS port_id`);
			console.log("   ✅ 已移除 devices.port_id 欄位");
		} catch (error) {
			console.warn(`   ⚠️  移除欄位失敗: ${error.message}`);
		}

		// 移除 device_type 欄位（已由 type_id 取代）
		try {
			await db.query(`ALTER TABLE devices DROP COLUMN IF EXISTS device_type`);
			console.log("   ✅ 已移除 devices.device_type 欄位");
		} catch (error) {
			console.warn(`   ⚠️  移除欄位失敗: ${error.message}`);
		}

		console.log("\n🎉 資料庫清理完成！");
		console.log(`📁 備份檔案位置: ${BACKUP_DIR}`);
		console.log("\n📊 備份統計:");
		for (const [table, backup] of Object.entries(backups)) {
			if (backup.count > 0) {
				console.log(`   ${table}: ${backup.count} 筆記錄`);
			}
		}

	} catch (error) {
		console.error("\n❌ 清理過程發生錯誤:", error.message);
		console.error(error);
		process.exit(1);
	} finally {
		await db.close();
	}
}

// 如果直接執行此腳本
if (require.main === module) {
	cleanupDatabase();
}

module.exports = { cleanupDatabase, backupTable, dropTable };

