/**
 * 創建測試警示資料
 * 用於測試警示系統功能
 */

const db = require("../src/database/db");
const alertService = require("../src/services/alertService");

async function createTestAlerts() {
	try {
		console.log("開始創建測試警示資料...");

		// 取得第一個啟用的感測器設備
		const sensorDevices = await db.query(
			`SELECT d.id, d.name, dt.code as type_code
			FROM devices d
			INNER JOIN device_types dt ON d.type_id = dt.id
			WHERE dt.code = 'sensor' AND d.status = 'active'
			LIMIT 1`
		);

		if (sensorDevices.length === 0) {
			console.log("⚠️  沒有找到啟用的感測器設備，無法創建測試警示");
			console.log("💡 請先創建至少一個啟用的感測器設備");
			return;
		}

		const sensorDevice = sensorDevices[0];
		console.log(`✅ 找到感測器設備: ${sensorDevice.name} (ID: ${sensorDevice.id})`);

		// 先清空該設備的現有測試警報
		console.log("🧹 清空該設備的現有警報...");
		const existingAlerts = await db.query(
			`SELECT COUNT(*) as count FROM device_alerts WHERE device_id = ?`,
			[sensorDevice.id]
		);
		const existingCount = parseInt(existingAlerts[0]?.count || 0);

		if (existingCount > 0) {
			await db.query(`DELETE FROM device_alerts WHERE device_id = ?`, [sensorDevice.id]);
			console.log(`✅ 已刪除 ${existingCount} 個現有警報`);
		} else {
			console.log("ℹ️  沒有現有警報需要刪除");
		}

		// 創建多個測試警示（注意：警報系統不處理 info 級別和 maintenance 類型）
		const testAlerts = [
			{
				device_id: sensorDevice.id,
				alert_type: "offline",
				severity: "warning",
				message: `感測器設備「${sensorDevice.name}」離線，無法讀取資料`
			},
			{
				device_id: sensorDevice.id,
				alert_type: "error",
				severity: "error",
				message: `感測器設備「${sensorDevice.name}」通訊錯誤，請檢查連接`
			},
			{
				device_id: sensorDevice.id,
				alert_type: "threshold",
				severity: "warning",
				message: `感測器設備「${sensorDevice.name}」CO2 濃度超過閾值 (800 ppm)`
			},
			{
				device_id: sensorDevice.id,
				alert_type: "offline",
				severity: "critical",
				message: `感測器設備「${sensorDevice.name}」長時間離線，請立即處理`
			}
		];

		let createdCount = 0;
		for (const alertData of testAlerts) {
			try {
				await alertService.createAlert(alertData);
				createdCount++;
				console.log(`✅ 創建警示: ${alertData.message}`);
			} catch (error) {
				console.error(`❌ 創建警示失敗: ${alertData.message}`, error.message);
			}
		}

		console.log(`\n✅ 完成！成功創建 ${createdCount}/${testAlerts.length} 個測試警示`);
	} catch (error) {
		console.error("❌ 創建測試警示失敗:", error);
		throw error;
	} finally {
		await db.close();
	}
}

// 執行
createTestAlerts()
	.then(() => {
		console.log("腳本執行完成");
		process.exit(0);
	})
	.catch((error) => {
		console.error("腳本執行失敗:", error);
		process.exit(1);
	});


