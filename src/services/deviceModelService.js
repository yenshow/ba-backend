const db = require("../database/db");
const { parseConfig, stringifyConfig } = require("../utils/deviceHelpers");

// 取得所有設備型號（支援按類型篩選）
async function getAllDeviceModels(filters = {}) {
	try {
		const { type_id, type_code } = filters;

		// 先嘗試從 device_models 讀取（新的通用表）
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

		let models = await db.query(query, params);

		// 如果 device_models 表不存在或為空，從 modbus_device_models 讀取（向後兼容）
		if (models.length === 0) {
			query = `
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
				WHERE 1=1
			`;
			const modbusParams = [];

			if (type_id) {
				query += " AND m.type_id = ?";
				modbusParams.push(type_id);
			}

			if (type_code) {
				query += " AND t.code = ?";
				modbusParams.push(type_code);
			}

			query += " ORDER BY m.id";
			models = await db.query(query, modbusParams);
		}

		// 解析 config JSON（如果存在）
		const modelsWithConfig = models.map((model) => ({
			...model,
			config: parseConfig(model.config)
		}));

		return { device_models: modelsWithConfig };
	} catch (error) {
		// 如果 device_models 表不存在，嘗試從 modbus_device_models 讀取
		try {
			const { type_id, type_code } = filters;
			let query = `
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
				WHERE 1=1
			`;
			const params = [];

			if (type_id) {
				query += " AND m.type_id = ?";
				params.push(type_id);
			}

			if (type_code) {
				query += " AND t.code = ?";
				params.push(type_code);
			}

			query += " ORDER BY m.id";
			const models = await db.query(query, params);

			return { device_models: models };
		} catch (fallbackError) {
			console.error("取得設備型號失敗:", error);
			throw new Error("取得設備型號失敗: " + error.message);
		}
	}
}

// 取得單一設備型號
async function getDeviceModelById(id) {
	try {
		let models = await db.query(
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

		// 如果 device_models 中找不到，嘗試從 modbus_device_models 讀取
		if (models.length === 0) {
			models = await db.query(
				`
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
			`,
				[id]
			);
		}

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
		const { name, type_id, description, config } = data;

		// 驗證必填欄位
		if (!name || name.trim().length === 0) {
			throw new Error("設備型號名稱不能為空");
		}

		if (!type_id) {
			throw new Error("設備類型 ID 不能為空");
		}

		// 驗證設備類型是否存在
		const types = await db.query("SELECT id FROM device_types WHERE id = ?", [type_id]);
		if (types.length === 0) {
			// 嘗試從 modbus_device_types 檢查
			const modbusTypes = await db.query("SELECT id FROM modbus_device_types WHERE id = ?", [type_id]);
			if (modbusTypes.length === 0) {
				throw new Error("設備類型不存在");
			}
		}

		// 嘗試插入到 device_models（新的通用表）
		let result;
		try {
			result = await db.query("INSERT INTO device_models (name, type_id, description, config) VALUES (?, ?, ?, ?)", [
				name.trim(),
				type_id,
				description || null,
				stringifyConfig(config)
			]);
		} catch (insertError) {
			// 如果 device_models 表不存在，可能需要先創建表
			throw new Error("設備型號表不存在，請先執行資料庫遷移腳本");
		}

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
			[result.insertId]
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
		const { name, type_id, description, config } = data;

		// 檢查設備型號是否存在
		let existing = await db.query("SELECT * FROM device_models WHERE id = ?", [id]);

		// 如果 device_models 中找不到，嘗試從 modbus_device_models 讀取
		if (existing.length === 0) {
			existing = await db.query("SELECT * FROM modbus_device_models WHERE id = ?", [id]);
			if (existing.length > 0) {
				throw new Error("此設備型號存在於舊表中，請先遷移到新表");
			}
		}

		if (existing.length === 0) {
			const error = new Error("設備型號不存在");
			error.statusCode = 404;
			throw error;
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
			// 驗證設備類型是否存在
			const types = await db.query("SELECT id FROM device_types WHERE id = ?", [type_id]);
			if (types.length === 0) {
				const modbusTypes = await db.query("SELECT id FROM modbus_device_types WHERE id = ?", [type_id]);
				if (modbusTypes.length === 0) {
					throw new Error("設備類型不存在");
				}
			}

			// 檢查是否有設備使用此型號
			const devices = await db.query("SELECT id FROM devices WHERE model_id = ? LIMIT 1", [id]);
			if (devices.length > 0) {
				throw new Error("無法更改類型：仍有設備使用此型號");
			}

			updates.push("type_id = ?");
			params.push(type_id);
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
		let models = await db.query("SELECT id FROM device_models WHERE id = ?", [id]);

		// 如果 device_models 中找不到，嘗試從 modbus_device_models 讀取
		if (models.length === 0) {
			models = await db.query("SELECT id FROM modbus_device_models WHERE id = ?", [id]);
			if (models.length > 0) {
				throw new Error("此設備型號存在於舊表中，請先遷移到新表");
			}
		}

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
