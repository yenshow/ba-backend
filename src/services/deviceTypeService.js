const db = require("../database/db");

// 取得所有設備類型
async function getAllDeviceTypes() {
	try {
		const deviceTypes = await db.query("SELECT * FROM device_types ORDER BY id");
		return { device_types: deviceTypes };
	} catch (error) {
		console.error("取得設備類型失敗:", error);
		throw new Error("取得設備類型失敗: " + error.message);
	}
}

// 取得單一設備類型
async function getDeviceTypeById(id) {
	try {
		const deviceTypes = await db.query("SELECT * FROM device_types WHERE id = ?", [id]);

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

// 根據代碼取得設備類型
async function getDeviceTypeByCode(code) {
	try {
		const deviceTypes = await db.query("SELECT * FROM device_types WHERE code = ?", [code]);

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

// 建立設備類型
async function createDeviceType(deviceTypeData) {
	try {
		const { name, code, description } = deviceTypeData;

		if (!name || name.trim().length === 0) {
			throw new Error("設備類型名稱不能為空");
		}

		if (!code || code.trim().length === 0) {
			throw new Error("設備類型代碼不能為空");
		}

		// 檢查代碼是否已存在
		const existing = await db.query("SELECT id FROM device_types WHERE code = ?", [code]);
		if (existing.length > 0) {
			throw new Error("設備類型代碼已存在");
		}

		const result = await db.query("INSERT INTO device_types (name, code, description) VALUES (?, ?, ?) RETURNING id", [
			name.trim(),
			code.trim(),
			description || null
		]);

		const deviceTypes = await db.query("SELECT * FROM device_types WHERE id = ?", [result[0].id]);

		return {
			message: "設備類型建立成功",
			device_type: deviceTypes[0]
		};
	} catch (error) {
		console.error("建立設備類型失敗:", error);
		throw new Error("建立設備類型失敗: " + error.message);
	}
}

// 更新設備類型
async function updateDeviceType(id, deviceTypeData) {
	try {
		const { name, code, description } = deviceTypeData;

		// 檢查設備類型是否存在
		const existing = await db.query("SELECT * FROM device_types WHERE id = ?", [id]);
		if (existing.length === 0) {
			const error = new Error("設備類型不存在");
			error.statusCode = 404;
			throw error;
		}

		const updates = [];
		const params = [];

		if (name !== undefined) {
			if (name.trim().length === 0) {
				throw new Error("設備類型名稱不能為空");
			}
			updates.push("name = ?");
			params.push(name.trim());
		}

		if (code !== undefined) {
			if (code.trim().length === 0) {
				throw new Error("設備類型代碼不能為空");
			}

			// 檢查代碼是否已被其他記錄使用
			const existingCode = await db.query("SELECT id FROM device_types WHERE code = ? AND id != ?", [code, id]);
			if (existingCode.length > 0) {
				throw new Error("設備類型代碼已被使用");
			}

			updates.push("code = ?");
			params.push(code.trim());
		}

		if (description !== undefined) {
			updates.push("description = ?");
			params.push(description || null);
		}

		if (updates.length === 0) {
			throw new Error("沒有提供要更新的欄位");
		}

		params.push(id);

		await db.query(`UPDATE device_types SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);

		const deviceTypes = await db.query("SELECT * FROM device_types WHERE id = ?", [id]);

		return {
			message: "設備類型更新成功",
			device_type: deviceTypes[0]
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("更新設備類型失敗:", error);
		throw new Error("更新設備類型失敗: " + error.message);
	}
}

// 刪除設備類型
async function deleteDeviceType(id) {
	try {
		// 檢查設備類型是否存在
		const deviceTypes = await db.query("SELECT id FROM device_types WHERE id = ?", [id]);
		if (deviceTypes.length === 0) {
			const error = new Error("設備類型不存在");
			error.statusCode = 404;
			throw error;
		}

		// 檢查是否有設備使用此類型
		const devices = await db.query("SELECT id FROM devices WHERE type_id = ? LIMIT 1", [id]);
		if (devices.length > 0) {
			throw new Error("無法刪除：仍有設備使用此類型");
		}

		await db.query("DELETE FROM device_types WHERE id = ?", [id]);

		return { message: "設備類型已刪除" };
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("刪除設備類型失敗:", error);
		throw new Error("刪除設備類型失敗: " + error.message);
	}
}

module.exports = {
	getAllDeviceTypes,
	getDeviceTypeById,
	getDeviceTypeByCode,
	createDeviceType,
	updateDeviceType,
	deleteDeviceType
};
