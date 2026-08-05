const userService = require("../src/services/platform/userService");
const db = require("../src/database/db");

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "Aa83124007";

async function createAdmin() {
	try {
		const existing = await db.query("SELECT id FROM users WHERE username = ?", [ADMIN_USERNAME]);

		if (existing.length > 0) {
			console.log(`[createAdmin] 已存在管理員：${ADMIN_USERNAME}`);
			return;
		}

		console.log(`[createAdmin] 正在建立管理員（${ADMIN_USERNAME}）…`);
		const user = await userService.createBootstrapAdminUser({
			username: ADMIN_USERNAME,
			password: ADMIN_PASSWORD,
		});

		console.log(`[createAdmin] 成功：${user.username}（${user.role}/${user.status}）`);
	} catch (error) {
		console.error(`[createAdmin] 失敗：${error.message}`);
		process.exit(1);
	} finally {
		await db.close();
	}
}

if (require.main === module) {
	createAdmin();
}

module.exports = { createAdmin };
