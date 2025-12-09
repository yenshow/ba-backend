const db = require("../database/db");

// 取得所有設備類型
async function getAllDeviceTypes() {
	try {
		const deviceTypes = await db.query("SELECT * FROM modbus_device_types ORDER BY id");
		return { device_types: deviceTypes };
	} catch (error) {
		console.error("取得設備類型失敗:", error);
		throw new Error("取得設備類型失敗: " + error.message);
	}
}

// 取得單一設備類型
async function getDeviceTypeById(id) {
	try {
		const deviceTypes = await db.query("SELECT * FROM modbus_device_types WHERE id = ?", [id]);
		if (deviceTypes.length === 0) {
			const error = new Error("設備類型不存在");
			error.statusCode = 404;
			throw error;
		}
		return { device_type: deviceTypes[0] };
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("取得設備類型失敗:", error);
		throw new Error("取得設備類型失敗: " + error.message);
	}
}

// 注意：設備類型管理功能已移除，僅保留讀取功能
// 設備類型資料應透過資料庫初始化腳本或直接操作資料庫進行管理
// 此服務僅提供讀取功能，供設備型號管理選擇類型時使用

module.exports = {
	getAllDeviceTypes,
	getDeviceTypeById
};

