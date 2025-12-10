const db = require("../database/db");
const { parseConfig, stringifyConfig, validateDeviceConfig } = require("../utils/deviceHelpers");

// 取得設備列表
async function getDevices(filters = {}) {
	try {
		const { type_id, type_code, status, limit = 20, offset = 0, orderBy = "created_at", order = "desc" } = filters;

		let query = `
			SELECT 
				d.*,
				dt.name as type_name,
				dt.code as type_code,
				dm.name as model_name
			FROM devices d
			INNER JOIN device_types dt ON d.type_id = dt.id
			LEFT JOIN device_models dm ON d.model_id = dm.id
			WHERE 1=1
		`;
		const params = [];

		if (type_id) {
			query += " AND d.type_id = ?";
			params.push(type_id);
		}

		if (type_code) {
			query += " AND dt.code = ?";
			params.push(type_code);
		}

		if (status) {
			query += " AND d.status = ?";
			params.push(status);
		}

		// 排序
		const validOrderBy = ["created_at", "updated_at", "name", "status"];
		const orderByField = validOrderBy.includes(orderBy) ? orderBy : "created_at";
		const orderDirection = order.toLowerCase() === "asc" ? "ASC" : "DESC";
		query += ` ORDER BY d.${orderByField} ${orderDirection}`;

		// 分頁
		query += " LIMIT ? OFFSET ?";
		params.push(parseInt(limit), parseInt(offset));

		const devices = await db.query(query, params);

		// 取得總數
		let countQuery = `
			SELECT COUNT(*) as total
			FROM devices d
			INNER JOIN device_types dt ON d.type_id = dt.id
			WHERE 1=1
		`;
		const countParams = [];

		if (type_id) {
			countQuery += " AND d.type_id = ?";
			countParams.push(type_id);
		}

		if (type_code) {
			countQuery += " AND dt.code = ?";
			countParams.push(type_code);
		}

		if (status) {
			countQuery += " AND d.status = ?";
			countParams.push(status);
		}

		const countResult = await db.query(countQuery, countParams);
		const total = countResult[0].total;

		// 解析 config JSON
		const devicesWithConfig = devices.map((device) => ({
			...device,
			config: parseConfig(device.config)
		}));

		return {
			devices: devicesWithConfig,
			total: parseInt(total),
			limit: parseInt(limit),
			offset: parseInt(offset)
		};
	} catch (error) {
		console.error("取得設備列表失敗:", error);
		throw new Error("取得設備列表失敗: " + error.message);
	}
}

// 取得單一設備
async function getDeviceById(id) {
	try {
		const devices = await db.query(
			`
			SELECT 
				d.*,
				dt.name as type_name,
				dt.code as type_code,
				dm.name as model_name
			FROM devices d
			INNER JOIN device_types dt ON d.type_id = dt.id
			LEFT JOIN device_models dm ON d.model_id = dm.id
			WHERE d.id = ?
		`,
			[id]
		);

		if (devices.length === 0) {
			const error = new Error("設備不存在");
			error.statusCode = 404;
			throw error;
		}

		const device = devices[0];
		device.config = parseConfig(device.config);

		return { device };
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("取得設備失敗:", error);
		throw new Error("取得設備失敗: " + error.message);
	}
}

// 創建設備
async function createDevice(deviceData, userId) {
	try {
		const { name, type_id, model_id, description, status, config } = deviceData;

		// 驗證必填欄位
		if (!name || name.trim().length === 0) {
			throw new Error("設備名稱不能為空");
		}

		if (name.length > 100) {
			throw new Error("設備名稱長度不能超過 100 字元");
		}

		if (!type_id) {
			throw new Error("設備類型 ID 不能為空");
		}

		if (!config) {
			throw new Error("設備配置不能為空");
		}

		// 驗證設備類型是否存在
		const types = await db.query("SELECT id, code FROM device_types WHERE id = ?", [type_id]);
		if (types.length === 0) {
			throw new Error("設備類型不存在");
		}

		const typeCode = types[0].code;

		// 驗證配置
		validateDeviceConfig(config, typeCode);

		// 如果提供了 model_id，驗證它是否存在且類型匹配
		if (model_id) {
			const models = await db.query("SELECT id, type_id FROM device_models WHERE id = ?", [model_id]);
			if (models.length === 0) {
				throw new Error("設備型號不存在");
			}

			if (models[0].type_id !== type_id) {
				throw new Error("設備型號的類型與設備類型不匹配");
			}
		}

		// 建立設備
		const result = await db.query(
			"INSERT INTO devices (name, type_id, model_id, description, status, config, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
			[name.trim(), type_id, model_id || null, description || null, status || "inactive", stringifyConfig(config), userId || null]
		);

		// 取得建立的設備
		return await getDeviceById(result[0].id);
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("創建設備失敗:", error);
		throw new Error("創建設備失敗: " + error.message);
	}
}

// 更新設備
async function updateDevice(id, deviceData, userId) {
	try {
		const { name, type_id, model_id, description, status, config } = deviceData;

		// 檢查設備是否存在
		const existing = await db.query("SELECT * FROM devices WHERE id = ?", [id]);
		if (existing.length === 0) {
			const error = new Error("設備不存在");
			error.statusCode = 404;
			throw error;
		}

		const existingDevice = existing[0];

		// 構建更新欄位
		const updates = [];
		const params = [];

		if (name !== undefined) {
			if (name.trim().length === 0) {
				throw new Error("設備名稱不能為空");
			}
			if (name.length > 100) {
				throw new Error("設備名稱長度不能超過 100 字元");
			}
			updates.push("name = ?");
			params.push(name.trim());
		}

		if (type_id !== undefined) {
			// 驗證設備類型是否存在
			const types = await db.query("SELECT id, code FROM device_types WHERE id = ?", [type_id]);
			if (types.length === 0) {
				throw new Error("設備類型不存在");
			}
			updates.push("type_id = ?");
			params.push(type_id);
		}

		if (model_id !== undefined) {
			if (model_id === null || model_id === 0) {
				updates.push("model_id = NULL");
			} else {
				// 驗證設備型號是否存在
				const models = await db.query("SELECT id, type_id FROM device_models WHERE id = ?", [model_id]);
				if (models.length === 0) {
					throw new Error("設備型號不存在");
				}

				// 驗證類型匹配
				const currentTypeId = type_id !== undefined ? type_id : existingDevice.type_id;
				if (models[0].type_id !== currentTypeId) {
					throw new Error("設備型號的類型與設備類型不匹配");
				}

				updates.push("model_id = ?");
				params.push(model_id);
			}
		}

		if (description !== undefined) {
			updates.push("description = ?");
			params.push(description || null);
		}

		if (status !== undefined) {
			if (!["active", "inactive", "error"].includes(status)) {
				throw new Error("狀態必須為 active, inactive 或 error");
			}
			updates.push("status = ?");
			params.push(status);
		}

		if (config !== undefined) {
			// 取得當前或新的類型代碼
			let currentTypeId = type_id !== undefined ? type_id : existingDevice.type_id;
			const types = await db.query("SELECT code FROM device_types WHERE id = ?", [currentTypeId]);
			const typeCode = types[0].code;

			// 驗證配置
			validateDeviceConfig(config, typeCode);

			updates.push("config = ?");
			params.push(stringifyConfig(config));
		}

		if (updates.length === 0) {
			throw new Error("沒有提供要更新的欄位");
		}

		params.push(id);

		await db.query(`UPDATE devices SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);

		// 取得更新後的設備
		return await getDeviceById(id);
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("更新設備失敗:", error);
		throw new Error("更新設備失敗: " + error.message);
	}
}

// 刪除設備
async function deleteDevice(id) {
	try {
		// 檢查設備是否存在
		const devices = await db.query("SELECT id FROM devices WHERE id = ?", [id]);
		if (devices.length === 0) {
			const error = new Error("設備不存在");
			error.statusCode = 404;
			throw error;
		}

		await db.query("DELETE FROM devices WHERE id = ?", [id]);

		return { message: "設備已刪除" };
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("刪除設備失敗:", error);
		throw new Error("刪除設備失敗: " + error.message);
	}
}

module.exports = {
	getDevices,
	getDeviceById,
	createDevice,
	updateDevice,
	deleteDevice
};
