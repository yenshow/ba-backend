const userService = require("../src/services/platform/userService");
const db = require("../src/database/db");

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "Aa83124007";

async function createAdmin() {
	try {
		console.log("=".repeat(60));
		console.log("建立系統管理員");
		console.log("=".repeat(60));
		console.log();

		const existing = await db.query("SELECT id FROM users WHERE username = ?", [ADMIN_USERNAME]);

		if (existing.length > 0) {
			console.log(`已存在管理員：${ADMIN_USERNAME}`);
			return;
		}

		console.log(`正在建立管理員... (${ADMIN_USERNAME})`);
		const user = await userService.registerUser({
			username: ADMIN_USERNAME,
			password: ADMIN_PASSWORD,
			role: "admin"
		});

		console.log();
		console.log("✅ 管理員建立成功！");
		console.log("=".repeat(60));
		console.log(`用戶名: ${user.username}`);
		console.log(`角色: ${user.role}`);
		console.log(`狀態: ${user.status}`);
		console.log("=".repeat(60));

	} catch (error) {
		console.error();
		console.error("❌ 建立管理員失敗:", error.message);
		process.exit(1);
	} finally {
		await db.close();
	}
}

// 如果直接執行此腳本（GUI / Redirect 子程序須明確結束，否則父程序 WaitForExit 會卡住）
if (require.main === module) {
	createAdmin()
		.then(() => process.exit(0))
		.catch(() => process.exit(1));
}

module.exports = { createAdmin };

