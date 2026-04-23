const db = require("../../database/db");
const { parseConfig, stringifyConfig } = require("../../utils/deviceHelpers");
const logger = require("../../utils/logger");
const {
	normalizeDeviceTypeCode,
	getDeviceTypeName
} = require("../../constants/deviceTypes");

const deviceModelLogger = logger.createLogger("deviceModelService");

/** 將表單值轉為整數或 null（undefined/null/空字串 → null） */
function parseOptionalInt(val) {
	if (val === undefined || val === null || val === "") return null;
	const n = Number(val);
	return Number.isInteger(n) ? n : null;
}

// 取得所有設備型號（支援按類型篩選）
async function getAllDeviceModels(filters = {}) {
	try {
		const { type_code } = filters;

		let query = `
			SELECT 
				dm.*
			FROM device_models dm
			WHERE 1=1
		`;
		const params = [];

		if (type_code) {
			query += " AND dm.type_code = ?";
			params.push(type_code);
		}

		query += " ORDER BY dm.id";

		const models = await db.query(query, params);

		// 解析 config JSON（如果存在）
		const modelsWithConfig = models.map((model) => ({
			...model,
			type_name: getDeviceTypeName(model.type_code),
			config: parseConfig(model.config)
		}));

		return { device_models: modelsWithConfig };
	} catch (error) {
		deviceModelLogger.error("取得設備型號失敗", {
			error: error?.message || String(error),
			module: "deviceModelService",
		});
		throw new Error("取得設備型號失敗: " + error.message);
	}
}

// 取得單一設備型號
async function getDeviceModelById(id) {
	try {
		const models = await db.query(
			`
			SELECT 
				dm.*
			FROM device_models dm
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
		model.type_name = getDeviceTypeName(model.type_code);
		model.config = parseConfig(model.config);

		return { device_model: model };
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		deviceModelLogger.error("取得設備型號失敗", {
			id,
			error: error?.message || String(error),
			module: "deviceModelService",
		});
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
		}
		// 型號層級 registerType（本型號統一使用的 Modbus API 方法）
		const validRegisterTypes = ["coils", "discrete", "holding", "input"];
		if (config.registerType != null && !validRegisterTypes.includes(config.registerType)) {
			throw new Error(`config.registerType 須為 ${validRegisterTypes.join(", ")} 之一`);
		}
	}
}

// 建立設備型號
async function createDeviceModel(data, userId) {
	try {
		const { name, type_code, port, unit_id, description, config } = data;

		// 驗證必填欄位
		if (!name || name.trim().length === 0) {
			throw new Error("設備型號名稱不能為空");
		}

		const inputTypeCode = normalizeDeviceTypeCode(type_code);
		if (!inputTypeCode) {
			throw new Error("設備類型不能為空");
		}

		// 驗證端口與 unit_id（選填）
		const finalPort = parseOptionalInt(port);
		if (finalPort !== null && (finalPort < 1 || finalPort > 65535)) {
			throw new Error("端口必須是 1-65535 之間的整數");
		}
		const finalUnitId = parseOptionalInt(unit_id);
		if (finalUnitId !== null && (finalUnitId < 1 || finalUnitId > 255)) {
			throw new Error("Unit ID 必須是 1-255 之間的整數");
		}

		const resolvedTypeCode = inputTypeCode;

		// 如果是感測器類型，驗證 sensorParameters 配置
		if (config && resolvedTypeCode === "sensor") {
			validateSensorParametersConfig(config);
		}

		// 驗證 logging 配置（如果提供）
		if (config && config.logging) {
			const { validateLoggingConfig } = require("../../utils/deviceHelpers");
			const loggingValidation = validateLoggingConfig(config.logging);
			if (!loggingValidation.valid) {
				throw new Error(`logging 配置驗證失敗: ${loggingValidation.error}`);
			}
		}

		// 插入到 device_models
		const result = await db.query(
			"INSERT INTO device_models (name, type_code, port, unit_id, description, config) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
			[name.trim(), resolvedTypeCode, finalPort, finalUnitId, description || null, stringifyConfig(config)]
		);

		const models = await db.query(
			`
			SELECT 
				dm.*
			FROM device_models dm
			WHERE dm.id = ?
		`,
			[result[0].id]
		);

		const model = models[0];
		model.type_name = getDeviceTypeName(model.type_code);
		model.config = parseConfig(model.config);

		return {
			message: "設備型號建立成功",
			device_model: model
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		deviceModelLogger.error("建立設備型號失敗", {
			error: error?.message || String(error),
			module: "deviceModelService",
		});
		throw new Error("建立設備型號失敗: " + error.message);
	}
}

// 更新設備型號
async function updateDeviceModel(id, data, userId) {
	try {
		const { name, type_code, port, unit_id, description, config } = data;

		// 檢查設備型號是否存在
		const existing = await db.query("SELECT * FROM device_models WHERE id = ?", [id]);

		if (existing.length === 0) {
			const error = new Error("設備型號不存在");
			error.statusCode = 404;
			throw error;
		}

		// 驗證端口與 unit_id（選填）
		if (port !== undefined) {
			const p = parseOptionalInt(port);
			if (p !== null && (p < 1 || p > 65535)) {
				throw new Error("端口必須是 1-65535 之間的整數");
			}
		}
		if (unit_id !== undefined) {
			const u = parseOptionalInt(unit_id);
			if (u !== null && (u < 1 || u > 255)) {
				throw new Error("Unit ID 必須是 1-255 之間的整數");
			}
		}

		const existingModel = existing[0];
		const currentTypeCode = String(existingModel.type_code || "");

		// 支援改 type_code（但若有設備使用則禁止）
		const inputTypeCode = type_code !== undefined ? normalizeDeviceTypeCode(type_code) : null;
		if (type_code !== undefined && !inputTypeCode) {
			throw new Error("設備類型代碼不正確");
		}
		const wantsChangeType = inputTypeCode && inputTypeCode !== currentTypeCode;
		if (wantsChangeType) {
			const devices = await db.query("SELECT id FROM devices WHERE model_id = ? LIMIT 1", [id]);
			if (devices.length > 0) {
				throw new Error("無法更改類型：仍有設備使用此型號");
			}
		}

		// 驗證 config（如果是感測器類型）
		if (config !== undefined) {
			const targetTypeCode = inputTypeCode || currentTypeCode;
			if (targetTypeCode === "sensor") {
				validateSensorParametersConfig(config);
			}

			// 驗證 logging 配置（如果提供）
			if (config.logging) {
				const { validateLoggingConfig } = require("../../utils/deviceHelpers");
				const loggingValidation = validateLoggingConfig(config.logging);
				if (!loggingValidation.valid) {
					throw new Error(`logging 配置驗證失敗: ${loggingValidation.error}`);
				}
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

		if (type_code !== undefined) {
			updates.push("type_code = ?");
			params.push(inputTypeCode || currentTypeCode);
		}

		if (port !== undefined) {
			updates.push("port = ?");
			params.push(parseOptionalInt(port));
		}
		if (unit_id !== undefined) {
			updates.push("unit_id = ?");
			params.push(parseOptionalInt(unit_id));
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
				dm.*
			FROM device_models dm
			WHERE dm.id = ?
		`,
			[id]
		);

		const model = models[0];
		model.type_name = getDeviceTypeName(model.type_code);
		model.config = parseConfig(model.config);

		return {
			message: "設備型號更新成功",
			device_model: model
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		deviceModelLogger.error("更新設備型號失敗", {
			id,
			error: error?.message || String(error),
			module: "deviceModelService",
		});
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
		deviceModelLogger.error("刪除設備型號失敗", {
			id,
			error: error?.message || String(error),
			module: "deviceModelService",
		});
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
