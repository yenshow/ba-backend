const readline = require("readline");
const userService = require("../src/services/userService");
const db = require("../src/database/db");

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

function question(prompt) {
	return new Promise((resolve) => {
		rl.question(prompt, resolve);
	});
}

async function createAdmin() {
	try {
		console.log("=".repeat(60));
		console.log("建立系統管理員");
		console.log("=".repeat(60));
		console.log();

		// 檢查是否已有管理員
		const admins = await db.query("SELECT id, username, email FROM users WHERE role = 'admin'");
		if (admins.length > 0) {
			console.log("⚠️  系統中已有管理員：");
			admins.forEach((admin) => {
				console.log(`   - ${admin.username} (${admin.email})`);
			});
			console.log();
			const continueAnswer = await question("是否仍要建立新的管理員？(y/N): ");
			if (continueAnswer.toLowerCase() !== "y") {
				console.log("已取消");
				process.exit(0);
			}
		}

		// 取得用戶資訊
		const username = await question("用戶名: ");
		if (!username || username.trim() === "") {
			throw new Error("用戶名不能為空");
		}

		const email = await question("Email: ");
		if (!email || email.trim() === "") {
			throw new Error("Email 不能為空");
		}

		// 驗證 email 格式
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			throw new Error("Email 格式不正確");
		}

		const password = await question("密碼: ");
		if (!password || password.length < 6) {
			throw new Error("密碼長度至少需要 6 個字元");
		}

		const confirmPassword = await question("確認密碼: ");
		if (password !== confirmPassword) {
			throw new Error("兩次輸入的密碼不一致");
		}

		console.log();
		console.log("正在建立管理員...");

		// 建立管理員
		const user = await userService.registerUser({
			username: username.trim(),
			email: email.trim(),
			password,
			role: "admin"
		});

		console.log();
		console.log("✅ 管理員建立成功！");
		console.log("=".repeat(60));
		console.log(`用戶名: ${user.username}`);
		console.log(`Email: ${user.email}`);
		console.log(`角色: ${user.role}`);
		console.log(`狀態: ${user.status}`);
		console.log("=".repeat(60));
		console.log();
		console.log("💡 提示: 請妥善保管管理員帳號資訊");

	} catch (error) {
		console.error();
		console.error("❌ 建立管理員失敗:", error.message);
		process.exit(1);
	} finally {
		rl.close();
		await db.close();
	}
}

// 如果直接執行此腳本
if (require.main === module) {
	createAdmin();
}

module.exports = { createAdmin };

