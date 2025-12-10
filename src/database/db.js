const { Pool } = require("pg");
const config = require("../config");

// 建立連線池
const pool = new Pool({
	host: config.database.host,
	port: config.database.port,
	user: config.database.user,
	password: config.database.password,
	database: config.database.database,
	max: config.database.connectionLimit,
	idleTimeoutMillis: 30000,
	connectionTimeoutMillis: 2000
});

// 測試連線
async function testConnection() {
	try {
		const result = await pool.query("SELECT NOW()");
		console.log("✅ 資料庫連線成功");
		return true;
	} catch (error) {
		console.error("❌ 資料庫連線失敗:", error.message);
		return false;
	}
}

// 將 ? 佔位符轉換為 PostgreSQL 的 $1, $2, ...
function convertQueryParams(sql, params) {
	if (!params || params.length === 0) {
		return { sql, params: [] };
	}
	let paramIndex = 1;
	const convertedSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
	return { sql: convertedSql, params };
}

// 執行查詢（使用連線池）
async function query(sql, params = []) {
	try {
		const { sql: convertedSql, params: convertedParams } = convertQueryParams(sql, params);
		const result = await pool.query(convertedSql, convertedParams);
		// 返回 rows，但添加 rowCount 屬性以便訪問
		const rows = result.rows;
		rows.rowCount = result.rowCount;
		return rows;
	} catch (error) {
		console.error("資料庫查詢錯誤:", error.message);
		throw error;
	}
}

// 執行事務
async function transaction(callback) {
	const client = await pool.connect();

	// 為 client 提供包裝的 query 方法，支援參數轉換並返回 rows + rowCount
	const clientQuery = async (sql, params = []) => {
		const { sql: convertedSql, params: convertedParams } = convertQueryParams(sql, params);
		const result = await client.query(convertedSql, convertedParams);
		const rows = result.rows;
		rows.rowCount = result.rowCount;
		return rows;
	};

	try {
		await client.query("BEGIN");
		const result = await callback(clientQuery);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

// 關閉連線池
async function close() {
	await pool.end();
	console.log("資料庫連線池已關閉");
}

module.exports = {
	pool,
	query,
	transaction,
	testConnection,
	close
};
