const fs = require("fs");
const path = require("path");
const externalDb = require("../src/database/externalDb");
const externalDataService = require("../src/services/externalDataService");

/**
 * 讀取配置檔案
 */
function loadConfig(configPath) {
	const defaultConfigPath = path.join(__dirname, "test-external-db-config.json");
	const configFile = configPath || defaultConfigPath;

	if (!fs.existsSync(configFile)) {
		console.error(`❌ 配置檔案不存在: ${configFile}`);
		console.log(`\n💡 提示: 請建立配置檔案或使用預設配置`);
		process.exit(1);
	}

	try {
		const configContent = fs.readFileSync(configFile, "utf8");
		const config = JSON.parse(configContent);
		return config;
	} catch (error) {
		console.error(`❌ 讀取配置檔案失敗: ${error.message}`);
		process.exit(1);
	}
}

/**
 * 查詢資料表結構
 */
async function getTableSchema(tableName, schema) {
	try {
		const query = `
			SELECT 
				column_name,
				data_type,
				character_maximum_length,
				is_nullable,
				column_default
			FROM information_schema.columns
			WHERE table_schema = $1 
			AND table_name = $2
			ORDER BY ordinal_position
		`;
		return await externalDataService.executeQuery(query, [schema, tableName]);
	} catch (error) {
		throw new Error(`查詢資料表結構失敗: ${error.message}`);
	}
}

/**
 * 查詢資料表資料
 */
async function getTableData(tableName, schema, options = {}) {
	const { limit = 10, offset = 0, orderBy, orderDirection = "ASC" } = options;
	
	let query = `SELECT * FROM "${schema}"."${tableName}"`;
	
	if (orderBy) {
		query += ` ORDER BY "${orderBy}" ${orderDirection}`;
	}
	
	query += ` LIMIT $1 OFFSET $2`;
	
	return await externalDataService.executeQuery(query, [limit, offset]);
}

/**
 * 查詢資料表總筆數
 */
async function getTableCount(tableName, schema) {
	try {
		const query = `SELECT COUNT(*) as count FROM "${schema}"."${tableName}"`;
		const result = await externalDataService.executeQuery(query);
		return result[0]?.count || 0;
	} catch (error) {
		throw new Error(`查詢總筆數失敗: ${error.message}`);
	}
}

/**
 * 查詢單一資料表
 */
async function queryTable(tableConfig, index) {
	const { name, schema = "public", description, options = {} } = tableConfig;
	
	console.log(`\n${"=".repeat(60)}`);
	console.log(`📊 資料表 ${index + 1}: ${schema}.${name}`);
	if (description) {
		console.log(`📝 說明: ${description}`);
	}
	console.log("=".repeat(60));

	try {
		// 1. 查詢資料表結構
		if (tableConfig.showSchema !== false) {
			console.log("\n📋 資料表結構:");
			const schemaInfo = await getTableSchema(name, schema);
			if (schemaInfo && schemaInfo.length > 0) {
				console.table(schemaInfo);
			} else {
				console.log("  (無法取得結構資訊)");
			}
		}

		// 2. 查詢資料
		if (tableConfig.showData !== false) {
			console.log("\n📦 資料內容:");
			const data = await getTableData(name, schema, options);
			if (data && data.length > 0) {
				console.table(data);
				console.log(`\n📈 查詢到 ${data.length} 筆資料`);
			} else {
				console.log("  (資料表為空或無資料)");
			}
		}

		// 3. 查詢總筆數
		if (tableConfig.showCount !== false) {
			const count = await getTableCount(name, schema);
			console.log(`📊 總筆數: ${count}`);
		}
	} catch (error) {
		console.error(`❌ 查詢失敗: ${error.message}`);
	}
}

/**
 * 主測試函數
 */
async function testExternalDatabase() {
	// 解析命令列參數
	const args = process.argv.slice(2);
	let configPath = null;
	
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--config" || args[i] === "-c") {
			configPath = args[i + 1];
			i++;
		} else if (args[i] === "--help" || args[i] === "-h") {
			console.log(`
用法: node scripts/testExternalDatabase.js [選項]

選項:
  --config, -c <路徑>    指定配置檔案路徑（預設: scripts/test-external-db-config.json）
  --help, -h             顯示此說明訊息

配置檔案格式:
{
  "tables": [
    {
      "name": "資料表名稱",
      "schema": "schema名稱",
      "description": "說明",
      "options": {
        "limit": 10,
        "offset": 0,
        "orderBy": "id",
        "orderDirection": "DESC"
      },
      "showSchema": true,
      "showData": true,
      "showCount": true
    }
  ],
  "showSchema": true,
  "showData": true,
  "showCount": true
}
			`);
			process.exit(0);
		}
	}

	// 載入配置
	const config = loadConfig(configPath);
	
	console.log("=".repeat(60));
	console.log("外部資料庫測試腳本");
	if (config.description) {
		console.log(`說明: ${config.description}`);
	}
	console.log("=".repeat(60));
	console.log();

	// 1. 測試連線
	console.log("📡 步驟 1: 測試外部資料庫連線...");
	const connected = await externalDb.testConnection();
	if (!connected) {
		console.error("❌ 外部資料庫連線失敗，請檢查設定");
		process.exit(1);
	}
	console.log();

	// 2. 查詢配置中指定的資料表
	if (config.tables && config.tables.length > 0) {
		console.log("\n" + "=".repeat(60));
		console.log(`📊 開始查詢 ${config.tables.length} 個資料表`);
		console.log("=".repeat(60));

		for (let i = 0; i < config.tables.length; i++) {
			const tableConfig = {
				...config.tables[i],
				showSchema: config.tables[i].showSchema !== undefined ? config.tables[i].showSchema : config.showSchema !== false,
				showData: config.tables[i].showData !== undefined ? config.tables[i].showData : config.showData !== false,
				showCount: config.tables[i].showCount !== undefined ? config.tables[i].showCount : config.showCount !== false
			};
			await queryTable(tableConfig, i);
		}
	} else {
		console.log("\n⚠️  配置檔案中沒有指定要查詢的資料表");
	}

	console.log();
	console.log("=".repeat(60));
	console.log("✅ 測試完成");
	console.log("=".repeat(60));

	// 關閉連線
	await externalDb.close();
	process.exit(0);
}

// 執行測試
testExternalDatabase().catch((error) => {
	console.error("❌ 測試過程發生錯誤:", error);
	process.exit(1);
});
