/**
 * 將 permission_definitions 與 permissionCatalog.js（SSOT）對齊。
 * 用法：npm run db:sync-perms
 */
const db = require("../src/database/db");
const syncPermissionCatalog = require("../src/database/syncPermissionCatalog");

async function main() {
	try {
		const connected = await db.testConnection();
		if (!connected) {
			console.error("❌ 資料庫連線失敗，無法同步權限定義");
			process.exit(1);
		}
		console.log("正在同步權限定義（permissionCatalog → permission_definitions）…");
		await syncPermissionCatalog(db.pool);
		console.log("✅ 權限定義同步完成");
	} catch (error) {
		console.error("❌ 權限定義同步失敗:", error?.message || error);
		process.exit(1);
	} finally {
		await db.close();
	}
}

main();
