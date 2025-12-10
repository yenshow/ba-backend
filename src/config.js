const path = require("path");
const dotenv = require("dotenv");

dotenv.config({
	path: process.env.ENV_FILE || path.resolve(process.cwd(), ".env")
});

const toNumber = (value, fallback) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

module.exports = {
	serverHost: process.env.HOST || "0.0.0.0",
	serverPort: toNumber(process.env.PORT, 4000),
	modbus: {
		// 設備連線資訊由前端 API 請求中提供，此處僅保留全域設定
		timeout: toNumber(process.env.MODBUS_TIMEOUT, 2000)
	},
	database: {
		host: process.env.DB_HOST || "127.0.0.1",
		port: toNumber(process.env.DB_PORT, 5432),
		user: process.env.DB_USER || "postgres",
		password: process.env.DB_PASSWORD || "postgres",
		database: process.env.DB_NAME || "ba_system",
		connectionLimit: toNumber(process.env.DB_CONNECTION_LIMIT, 10),
		waitForConnections: true,
		queueLimit: 0
	},
	jwt: {
		secret: process.env.JWT_SECRET || "your-secret-key-change-in-production",
		expiresIn: process.env.JWT_EXPIRES_IN || "7d"
	}
};
