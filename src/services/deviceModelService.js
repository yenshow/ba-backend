const db = require("../database/db");

// 取得所有設備型號
async function getAllDeviceModels() {
	try {
		const models = await db.query(`
      SELECT 
        m.id,
        m.name,
        m.type_id,
        m.port,
        m.description,
        m.created_at,
        m.updated_at,
        t.name as type_name,
        t.code as type_code
      FROM modbus_device_models m
      LEFT JOIN modbus_device_types t ON m.type_id = t.id
      ORDER BY m.id
    `);
		return { device_models: models };
	} catch (error) {
		console.error("取得設備型號失敗:", error);
		throw new Error("取得設備型號失敗: " + error.message);
	}
}

// 取得單一設備型號
async function getDeviceModelById(id) {
	try {
		const models = await db.query(`
      SELECT 
        m.id,
        m.name,
        m.type_id,
        m.port,
        m.description,
        m.created_at,
        m.updated_at,
        t.name as type_name,
        t.code as type_code
      FROM modbus_device_models m
      LEFT JOIN modbus_device_types t ON m.type_id = t.id
      WHERE m.id = ?
    `, [id]);
		
		if (models.length === 0) {
			const error = new Error("設備型號不存在");
			error.statusCode = 404;
			throw error;
		}
		return { device_model: models[0] };
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("取得設備型號失敗:", error);
		throw new Error("取得設備型號失敗: " + error.message);
	}
}

// 建立設備型號
async function createDeviceModel(data, userId) {
	try {
		const { name, type_id, port, description } = data;

		// 驗證必填欄位
		if (!name || !type_id || port === undefined) {
			const error = new Error("設備型號名稱、類型和端口為必填欄位");
			error.statusCode = 400;
			throw error;
		}

		// 驗證端口範圍
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			const error = new Error("端口必須是 1-65535 之間的整數");
			error.statusCode = 400;
			throw error;
		}

		// 檢查類型是否存在
		const types = await db.query("SELECT id FROM modbus_device_types WHERE id = ?", [type_id]);
		if (types.length === 0) {
			const error = new Error("設備類型不存在");
			error.statusCode = 400;
			throw error;
		}

		// 插入資料
		const result = await db.query(
			"INSERT INTO modbus_device_models (name, type_id, port, description) VALUES (?, ?, ?, ?)",
			[name, type_id, port, description || null]
		);

		// 取得新建立的設備型號
		const models = await db.query(`
      SELECT 
        m.id,
        m.name,
        m.type_id,
        m.port,
        m.description,
        m.created_at,
        m.updated_at,
        t.name as type_name,
        t.code as type_code
      FROM modbus_device_models m
      LEFT JOIN modbus_device_types t ON m.type_id = t.id
      WHERE m.id = ?
    `, [result.insertId]);

		return {
			message: "設備型號建立成功",
			device_model: models[0]
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("建立設備型號失敗:", error);
		throw new Error("建立設備型號失敗: " + error.message);
	}
}

// 更新設備型號
async function updateDeviceModel(id, data, userId) {
	try {
		const { name, type_id, port, description } = data;

		// 檢查設備型號是否存在
		const existing = await db.query("SELECT * FROM modbus_device_models WHERE id = ?", [id]);
		if (existing.length === 0) {
			const error = new Error("設備型號不存在");
			error.statusCode = 404;
			throw error;
		}

		// 驗證端口（如果提供）
		if (port !== undefined) {
			if (!Number.isInteger(port) || port <= 0 || port > 65535) {
				const error = new Error("端口必須是 1-65535 之間的整數");
				error.statusCode = 400;
				throw error;
			}
		}

		// 檢查類型是否存在（如果提供）
		if (type_id !== undefined) {
			const types = await db.query("SELECT id FROM modbus_device_types WHERE id = ?", [type_id]);
			if (types.length === 0) {
				const error = new Error("設備類型不存在");
				error.statusCode = 400;
				throw error;
			}
		}

		// 構建更新語句
		const updateFields = [];
		const updateValues = [];

		if (name !== undefined) {
			updateFields.push("name = ?");
			updateValues.push(name);
		}
		if (type_id !== undefined) {
			updateFields.push("type_id = ?");
			updateValues.push(type_id);
		}
		if (port !== undefined) {
			updateFields.push("port = ?");
			updateValues.push(port);
		}
		if (description !== undefined) {
			updateFields.push("description = ?");
			updateValues.push(description);
		}

		if (updateFields.length === 0) {
			const error = new Error("沒有提供要更新的欄位");
			error.statusCode = 400;
			throw error;
		}

		updateValues.push(id);
		await db.query(`UPDATE modbus_device_models SET ${updateFields.join(", ")} WHERE id = ?`, updateValues);

		// 取得更新後的設備型號
		const models = await db.query(`
      SELECT 
        m.id,
        m.name,
        m.type_id,
        m.port,
        m.description,
        m.created_at,
        m.updated_at,
        t.name as type_name,
        t.code as type_code
      FROM modbus_device_models m
      LEFT JOIN modbus_device_types t ON m.type_id = t.id
      WHERE m.id = ?
    `, [id]);

		return {
			message: "設備型號更新成功",
			device_model: models[0]
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("更新設備型號失敗:", error);
		throw new Error("更新設備型號失敗: " + error.message);
	}
}

// 刪除設備型號
async function deleteDeviceModel(id) {
	try {
		// 檢查設備型號是否存在
		const existing = await db.query("SELECT * FROM modbus_device_models WHERE id = ?", [id]);
		if (existing.length === 0) {
			const error = new Error("設備型號不存在");
			error.statusCode = 404;
			throw error;
		}

		// 檢查是否有設備使用此型號
		const devices = await db.query("SELECT id FROM devices WHERE model_id = ? LIMIT 1", [id]);
		if (devices.length > 0) {
			const error = new Error("無法刪除：仍有設備使用此型號");
			error.statusCode = 400;
			throw error;
		}

		// 刪除設備型號
		await db.query("DELETE FROM modbus_device_models WHERE id = ?", [id]);

		return {
			message: "設備型號刪除成功"
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("刪除設備型號失敗:", error);
		throw new Error("刪除設備型號失敗: " + error.message);
	}
}

module.exports = {
	getAllDeviceModels,
	getDeviceModelById,
	createDeviceModel,
	updateDeviceModel,
	deleteDeviceModel
};

