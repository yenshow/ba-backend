const externalDb = require("../database/externalDb");

/**
 * 驗證資料表名稱（防止 SQL 注入）
 * 只允許字母、數字、底線，且不能以數字開頭
 */
function validateTableName(tableName) {
	if (!tableName || typeof tableName !== "string") {
		return false;
	}
	// 只允許字母、數字、底線，且不能以數字開頭
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName);
}

/**
 * 驗證欄位名稱（防止 SQL 注入）
 */
function validateColumnName(columnName) {
	if (!columnName || typeof columnName !== "string") {
		return false;
	}
	// 只允許字母、數字、底線，且不能以數字開頭
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(columnName);
}

/**
 * 取得所有資料表清單
 */
async function getTables() {
	const sql = `
		SELECT table_name 
		FROM information_schema.tables 
		WHERE table_schema = 'public' 
		ORDER BY table_name;
	`;
	return await externalDb.query(sql);
}

/**
 * 取得指定資料表的結構
 */
async function getTableSchema(tableName) {
	if (!validateTableName(tableName)) {
		throw new Error("無效的資料表名稱");
	}
	
	const sql = `
		SELECT 
			column_name,
			data_type,
			character_maximum_length,
			is_nullable,
			column_default
		FROM information_schema.columns
		WHERE table_schema = 'public' 
		AND table_name = $1
		ORDER BY ordinal_position;
	`;
	return await externalDb.query(sql, [tableName]);
}

/**
 * 查詢指定資料表的資料
 * @param {string} tableName - 資料表名稱
 * @param {object} options - 查詢選項
 * @param {number} options.limit - 限制筆數
 * @param {number} options.offset - 偏移量
 * @param {string} options.orderBy - 排序欄位
 * @param {string} options.orderDirection - 排序方向 (ASC/DESC)
 */
async function getTableData(tableName, options = {}) {
	if (!validateTableName(tableName)) {
		throw new Error("無效的資料表名稱");
	}
	
	const { limit = 100, offset = 0, orderBy, orderDirection = "ASC" } = options;
	
	let sql = `SELECT * FROM "${tableName}"`;
	const params = [];
	
	// 加入排序（驗證欄位名稱）
	if (orderBy) {
		if (!validateColumnName(orderBy)) {
			throw new Error("無效的排序欄位名稱");
		}
		const direction = orderDirection.toUpperCase() === "DESC" ? "DESC" : "ASC";
		sql += ` ORDER BY "${orderBy}" ${direction}`;
	}
	
	// 加入分頁
	sql += ` LIMIT $1 OFFSET $2`;
	params.push(limit, offset);
	
	return await externalDb.query(sql, params);
}

/**
 * 執行自訂 SQL 查詢（僅 SELECT）
 * @param {string} sql - SQL 查詢語句
 * @param {array} params - 查詢參數
 */
async function executeQuery(sql, params = []) {
	// 安全檢查：只允許 SELECT 查詢
	const trimmedSql = sql.trim().toUpperCase();
	if (!trimmedSql.startsWith("SELECT")) {
		throw new Error("只允許執行 SELECT 查詢");
	}
	
	return await externalDb.query(sql, params);
}

/**
 * 取得資料表總筆數
 */
async function getTableCount(tableName) {
	if (!validateTableName(tableName)) {
		throw new Error("無效的資料表名稱");
	}
	
	const sql = `SELECT COUNT(*) as count FROM "${tableName}"`;
	const result = await externalDb.query(sql);
	return result[0]?.count || 0;
}

module.exports = {
	getTables,
	getTableSchema,
	getTableData,
	executeQuery,
	getTableCount
};

