const mysql = require("mysql2/promise");
const config = require("../config");

// 建立連線池
const pool = mysql.createPool({
	host: config.database.host,
	port: config.database.port,
	user: config.database.user,
	password: config.database.password,
	database: config.database.database,
	waitForConnections: config.database.waitForConnections,
	connectionLimit: config.database.connectionLimit,
	queueLimit: config.database.queueLimit,
	enableKeepAlive: true,
	keepAliveInitialDelay: 0
});

// 測試連線
async function testConnection() {
	try {
		const connection = await pool.getConnection();
		await connection.ping();
		connection.release();
		console.log("✅ 資料庫連線成功");
		return true;
	} catch (error) {
		console.error("❌ 資料庫連線失敗:", error.message);
		return false;
	}
}

// 執行查詢（使用連線池）
async function query(sql, params = []) {
	try {
		const [results] = await pool.execute(sql, params);
		return results;
	} catch (error) {
		console.error("資料庫查詢錯誤:", error.message);
		throw error;
	}
}

// 執行事務
async function transaction(callback) {
	const connection = await pool.getConnection();
	await connection.beginTransaction();

	try {
		const result = await callback(connection);
		await connection.commit();
		return result;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
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
