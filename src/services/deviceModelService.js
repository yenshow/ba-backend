const db = require("../database/db");
const { parseConfig, stringifyConfig } = require("../utils/deviceHelpers");

// 取得所有設備型號（支援按類型篩選）
async function getAllDeviceModels(filters = {}) {
	try {
		const { type_id, type_code } = filters;

		let query = `
			SELECT 
				dm.*,
				dt.name as type_name,
				dt.code as type_code
			FROM device_models dm
			INNER JOIN device_types dt ON dm.type_id = dt.id
			WHERE 1=1
		`;
		const params = [];

		if (type_id) {
			query += " AND dm.type_id = ?";
			params.push(type_id);
		}

		if (type_code) {
			query += " AND dt.code = ?";
			params.push(type_code);
		}

		query += " ORDER BY dm.id";

		const models = await db.query(query, params);

		// 解析 config JSON（如果存在）
		const modelsWithConfig = models.map((model) => ({
			...model,
			config: parseConfig(model.config)
		}));

		return { device_models: modelsWithConfig };
	} catch (error) {
		console.error("取得設備型號失敗:", error);
		throw new Error("取得設備型號失敗: " + error.message);
	}
}

// 取得單一設備型號
async function getDeviceModelById(id) {
	try {
		const models = await db.query(
			`
			SELECT 
				dm.*,
				dt.name as type_name,
				dt.code as type_code
			FROM device_models dm
			INNER JOIN device_types dt ON dm.type_id = dt.id
			WHERE dm.id = ?
		`,
			[id]
		);

		if (models.length === 0) {
			const error = new Error("設備型號不存在");
			error.statusCode = 404;
			throw error;
		}

		const model = models[0];
		model.config = parseConfig(model.config);

		return { device_model: model };
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
		const { name, type_id, port, description, config } = data;

		// 驗證必填欄位
		if (!name || name.trim().length === 0) {
			throw new Error("設備型號名稱不能為空");
		}

		if (!type_id) {
			throw new Error("設備類型 ID 不能為空");
		}

		// 驗證端口（如果提供）
		const finalPort = port !== undefined ? port : 502; // 預設 502
		if (finalPort !== undefined && (!Number.isInteger(finalPort) || finalPort <= 0 || finalPort > 65535)) {
			throw new Error("端口必須是 1-65535 之間的整數");
		}

		// 驗證設備類型是否存在
		const types = await db.query("SELECT id FROM device_types WHERE id = ?", [type_id]);
		if (types.length === 0) {
			throw new Error("設備類型不存在");
		}

		// 插入到 device_models
		const result = await db.query(
			"INSERT INTO device_models (name, type_id, port, description, config) VALUES (?, ?, ?, ?, ?) RETURNING id",
			[name.trim(), type_id, finalPort, description || null, stringifyConfig(config)]
		);

		const models = await db.query(
			`
			SELECT 
				dm.*,
				dt.name as type_name,
				dt.code as type_code
			FROM device_models dm
			INNER JOIN device_types dt ON dm.type_id = dt.id
			WHERE dm.id = ?
		`,
			[result[0].id]
		);

		const model = models[0];
		model.config = parseConfig(model.config);

		return {
			message: "設備型號建立成功",
			device_model: model
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
		const { name, type_id, port, description, config } = data;

		// 檢查設備型號是否存在
		const existing = await db.query("SELECT * FROM device_models WHERE id = ?", [id]);

		if (existing.length === 0) {
			const error = new Error("設備型號不存在");
			error.statusCode = 404;
			throw error;
		}

		// 驗證端口（如果提供）
		if (port !== undefined) {
			if (!Number.isInteger(port) || port <= 0 || port > 65535) {
				throw new Error("端口必須是 1-65535 之間的整數");
			}
		}

		// 驗證設備類型是否存在（如果提供）
		if (type_id !== undefined) {
			const types = await db.query("SELECT id FROM device_types WHERE id = ?", [type_id]);
			if (types.length === 0) {
				throw new Error("設備類型不存在");
			}

			// 檢查是否有設備使用此型號
			const devices = await db.query("SELECT id FROM devices WHERE model_id = ? LIMIT 1", [id]);
			if (devices.length > 0) {
				throw new Error("無法更改類型：仍有設備使用此型號");
			}
		}

		const updates = [];
		const params = [];

		if (name !== undefined) {
			if (name.trim().length === 0) {
				throw new Error("設備型號名稱不能為空");
			}
			updates.push("name = ?");
			params.push(name.trim());
		}

		if (type_id !== undefined) {
			updates.push("type_id = ?");
			params.push(type_id);
		}

		if (port !== undefined) {
			updates.push("port = ?");
			params.push(port);
		}

		if (description !== undefined) {
			updates.push("description = ?");
			params.push(description || null);
		}

		if (config !== undefined) {
			updates.push("config = ?");
			params.push(stringifyConfig(config));
		}

		if (updates.length === 0) {
			throw new Error("沒有提供要更新的欄位");
		}

		params.push(id);

		await db.query(`UPDATE device_models SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);

		const models = await db.query(
			`
			SELECT 
				dm.*,
				dt.name as type_name,
				dt.code as type_code
			FROM device_models dm
			INNER JOIN device_types dt ON dm.type_id = dt.id
			WHERE dm.id = ?
		`,
			[id]
		);

		const model = models[0];
		model.config = parseConfig(model.config);

		return {
			message: "設備型號更新成功",
			device_model: model
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
		const models = await db.query("SELECT id FROM device_models WHERE id = ?", [id]);

		if (models.length === 0) {
			const error = new Error("設備型號不存在");
			error.statusCode = 404;
			throw error;
		}

		// 檢查是否有設備使用此型號
		const devices = await db.query("SELECT id FROM devices WHERE model_id = ? LIMIT 1", [id]);
		if (devices.length > 0) {
			throw new Error("無法刪除：仍有設備使用此型號");
		}

		await db.query("DELETE FROM device_models WHERE id = ?", [id]);

		return {
			message: "設備型號已刪除"
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
