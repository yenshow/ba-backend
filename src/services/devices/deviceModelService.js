const db = require("../../database/db");
const { parseConfig, stringifyConfig } = require("../../utils/deviceHelpers");

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

// 驗證感測器參數配置
function validateSensorParametersConfig(config) {
	if (!config || typeof config !== "object") {
		return; // config 是可選的
	}

	if (config.sensorParameters) {
		if (!Array.isArray(config.sensorParameters)) {
			throw new Error("sensorParameters 必須為陣列");
		}

		const validParameterTypes = ["pm25", "pm10", "tvoc", "hcho", "humidity", "temperature", "co2", "noise", "wind"];
		
		for (const param of config.sensorParameters) {
			if (!param.type) {
				throw new Error("參數定義必須包含 type 欄位");
			}
			if (!validParameterTypes.includes(param.type)) {
				throw new Error(`無效的參數類型: ${param.type}。有效類型: ${validParameterTypes.join(", ")}`);
			}
			if (!param.modbusConfig) {
				throw new Error(`參數 ${param.type} 必須包含 modbusConfig`);
			}
			if (typeof param.modbusConfig.address !== "number" || param.modbusConfig.address < 0) {
				throw new Error(`參數 ${param.type} 的 modbusConfig.address 必須為非負整數`);
			}
			// length 已移除：前端不再提供，後端統一使用預設值 1
		}
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
		const types = await db.query("SELECT id, code FROM device_types WHERE id = ?", [type_id]);
		if (types.length === 0) {
			throw new Error("設備類型不存在");
		}

		// 如果是感測器類型，驗證 sensorParameters 配置
		if (config && types[0].code === "sensor") {
			validateSensorParametersConfig(config);
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

		const existingModel = existing[0];
		const currentTypeId = existingModel.type_id;

		// 驗證設備類型是否存在（如果提供且與現有值不同）
		if (type_id !== undefined && type_id !== currentTypeId) {
			const types = await db.query("SELECT id, code FROM device_types WHERE id = ?", [type_id]);
			if (types.length === 0) {
				throw new Error("設備類型不存在");
			}

			// 只有在實際更改類型時才檢查是否有設備使用此型號
			const devices = await db.query("SELECT id FROM devices WHERE model_id = ? LIMIT 1", [id]);
			if (devices.length > 0) {
				throw new Error("無法更改類型：仍有設備使用此型號");
			}
		}

		// 驗證 config（如果是感測器類型）
		if (config !== undefined) {
			// 確定當前的設備類型（優先使用新的 type_id，否則使用現有的）
			const targetTypeId = type_id !== undefined ? type_id : currentTypeId;
			const types = await db.query("SELECT code FROM device_types WHERE id = ?", [targetTypeId]);
			if (types.length > 0 && types[0].code === "sensor") {
				validateSensorParametersConfig(config);
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
