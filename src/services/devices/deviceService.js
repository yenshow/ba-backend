const db = require("../../database/db");
const { parseConfig, stringifyConfig, validateDeviceConfig } = require("../../utils/deviceHelpers");
const websocketService = require("../websocket/websocketService");

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
				dm.id as model_id,
				dm.name as model_name,
				dm.port as model_port,
				dm.config as model_config
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

		// 如果設備有 model_id，包含完整的 model 資訊（含 config）
		if (device.model_id) {
			device.model = {
				id: device.model_id,
				name: device.model_name,
				port: device.model_port,
				config: parseConfig(device.model_config)
			};
		}

		// 移除臨時欄位
		delete device.model_id;
		delete device.model_name;
		delete device.model_port;
		delete device.model_config;

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

		// 驗證 model_id 必填
		if (!model_id) {
			throw new Error("設備型號 ID 不能為空");
		}

		// 驗證設備型號是否存在且類型匹配
		const models = await db.query("SELECT id, type_id, port FROM device_models WHERE id = ?", [model_id]);
		if (models.length === 0) {
			throw new Error("設備型號不存在");
		}

		if (models[0].type_id !== type_id) {
			throw new Error("設備型號的類型與設備類型不匹配");
		}

		const modelPort = models[0].port;

		// 驗證配置
		validateDeviceConfig(config, typeCode);

		// 對於 controller 類型的設備，處理連接資訊和自動生成 unitId
		if (typeCode === "controller") {
			if (!config.host) {
				throw new Error("controller 類型需要 host (主機位址)");
			}
			if (config.port === undefined && !modelPort) {
				throw new Error("controller 類型需要 port (端口)");
			}

			// 設定 port（優先使用 config.port，否則使用 model.port，最後預設 502）
			const finalPort = config.port !== undefined ? config.port : (modelPort || 502);
			config.port = finalPort;

			// 自動生成 unitId（如果未提供）
			if (config.unitId === undefined) {
				// 查詢相同 host + port 的設備，找出已使用的 unitId
				const existingDevices = await db.query(
					`SELECT config FROM devices 
					WHERE type_id = ? 
					AND config->>'host' = ? 
					AND (config->>'port')::integer = ?`,
					[type_id, config.host, finalPort]
				);

				// 找出已使用的 unitId
				const usedUnitIds = new Set();
				existingDevices.forEach((device) => {
					const deviceConfig = parseConfig(device.config);
					if (deviceConfig && deviceConfig.unitId !== undefined) {
						usedUnitIds.add(deviceConfig.unitId);
					}
				});

				// 從 1 開始找第一個未使用的 unitId
				let autoUnitId = 1;
				while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
					autoUnitId++;
				}

				if (autoUnitId > 255) {
					throw new Error("無法自動生成 unitId：已達到最大值 255");
				}

				config.unitId = autoUnitId;
			}

			// 檢查是否已有相同連接配置的設備（host + port + unitId）
			const existing = await db.query(
				`SELECT id FROM devices 
				WHERE type_id = ? 
				AND config->>'host' = ? 
				AND (config->>'port')::integer = ? 
				AND (config->>'unitId')::integer = ?`,
				[type_id, config.host, finalPort, config.unitId]
			);

			if (existing.length > 0) {
				throw new Error("已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）");
			}
		}

		// 對於 sensor (modbus) 類型的設備，處理連接資訊和自動生成 unitId
		if (typeCode === "sensor" && config.protocol === "modbus") {
			if (!config.host) {
				throw new Error("sensor (modbus) 類型需要 host (主機位址)");
			}
			if (config.port === undefined && !modelPort) {
				throw new Error("sensor (modbus) 類型需要 port (端口)");
			}

			// 設定 port（優先使用 config.port，否則使用 model.port，最後預設 502）
			const finalPort = config.port !== undefined ? config.port : (modelPort || 502);
			config.port = finalPort;

			// 自動生成 unitId（如果未提供）
			if (config.unitId === undefined) {
				// 查詢相同 host + port 的設備，找出已使用的 unitId
				const existingDevices = await db.query(
					`SELECT config FROM devices 
					WHERE type_id = ? 
					AND config->>'protocol' = 'modbus'
					AND config->>'host' = ? 
					AND (config->>'port')::integer = ?`,
					[type_id, config.host, finalPort]
				);

				// 找出已使用的 unitId
				const usedUnitIds = new Set();
				existingDevices.forEach((device) => {
					const deviceConfig = parseConfig(device.config);
					if (deviceConfig && deviceConfig.protocol === "modbus" && deviceConfig.unitId !== undefined) {
						usedUnitIds.add(deviceConfig.unitId);
					}
				});

				// 從 1 開始找第一個未使用的 unitId
				let autoUnitId = 1;
				while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
					autoUnitId++;
				}

				if (autoUnitId > 255) {
					throw new Error("無法自動生成 unitId：已達到最大值 255");
				}

				config.unitId = autoUnitId;
			}

			// 檢查是否已有相同連接配置的設備（host + port + unitId）
			const existing = await db.query(
				`SELECT id FROM devices 
				WHERE type_id = ? 
				AND config->>'protocol' = 'modbus'
				AND config->>'host' = ? 
				AND (config->>'port')::integer = ? 
				AND (config->>'unitId')::integer = ?`,
				[type_id, config.host, finalPort, config.unitId]
			);

			if (existing.length > 0) {
				throw new Error("已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）");
			}
		}

		// 建立設備
		const result = await db.query(
			"INSERT INTO devices (name, type_id, model_id, description, status, config, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
			[
				name.trim(),
				type_id,
				model_id,
				description || null,
				status || "inactive",
				stringifyConfig(config),
				userId || null
			]
		);

		// 取得建立的設備
		const deviceResult = await getDeviceById(result[0].id);
		
		// 推送 WebSocket 事件：設備創建
		websocketService.emitDeviceCreated({
			device: deviceResult.device,
			userId,
		});
		
		return deviceResult;
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
			// model_id 現在是必填的，不能為 null
			if (!model_id) {
				throw new Error("設備型號 ID 不能為空");
			}

			// 驗證設備型號是否存在
			const models = await db.query("SELECT id, type_id, port FROM device_models WHERE id = ?", [model_id]);
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

			// 對於 controller 類型的設備，處理連接資訊和自動生成 unitId
			if (typeCode === "controller") {
				const existingConfig = parseConfig(existingDevice.config);
				const finalModelId = model_id !== undefined ? model_id : existingDevice.model_id;

				// 獲取 model port
				let modelPort = null;
				if (finalModelId) {
					const models = await db.query("SELECT port FROM device_models WHERE id = ?", [finalModelId]);
					if (models.length > 0) {
						modelPort = models[0].port;
					}
				}

				// 設定 port（優先使用 config.port，否則使用 model.port，最後使用現有 port，最後預設 502）
				const finalPort = config.port !== undefined ? config.port : (modelPort || existingConfig?.port || 502);
				config.port = finalPort;

				// 自動生成 unitId（如果未提供且 host 或 port 有變更）
				if (config.unitId === undefined) {
					const finalHost = config.host || existingConfig?.host;
					
					if (finalHost && finalPort) {
						// 查詢相同 host + port 的設備，找出已使用的 unitId（排除當前設備）
						const existingDevices = await db.query(
							`SELECT config FROM devices 
							WHERE type_id = ? 
							AND id != ?
							AND config->>'host' = ? 
							AND (config->>'port')::integer = ?`,
							[currentTypeId, id, finalHost, finalPort]
						);

						// 找出已使用的 unitId
						const usedUnitIds = new Set();
						existingDevices.forEach((device) => {
							const deviceConfig = parseConfig(device.config);
							if (deviceConfig && deviceConfig.unitId !== undefined) {
								usedUnitIds.add(deviceConfig.unitId);
							}
						});

						// 如果現有設備有 unitId，優先使用
						if (existingConfig && existingConfig.unitId !== undefined) {
							if (!usedUnitIds.has(existingConfig.unitId)) {
								config.unitId = existingConfig.unitId;
							} else {
								// 現有的 unitId 已被使用，找新的
								let autoUnitId = 1;
								while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
									autoUnitId++;
								}
								if (autoUnitId > 255) {
									throw new Error("無法自動生成 unitId：已達到最大值 255");
								}
								config.unitId = autoUnitId;
							}
						} else {
							// 從 1 開始找第一個未使用的 unitId
							let autoUnitId = 1;
							while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
								autoUnitId++;
							}
							if (autoUnitId > 255) {
								throw new Error("無法自動生成 unitId：已達到最大值 255");
							}
							config.unitId = autoUnitId;
						}
					}
				}

				// 檢查是否已有相同連接配置的設備（host + port + unitId，排除當前設備）
				if (config.host && config.port !== undefined && config.unitId !== undefined) {
					const existing = await db.query(
						`SELECT id FROM devices 
						WHERE type_id = ? 
						AND id != ?
						AND config->>'host' = ? 
						AND (config->>'port')::integer = ? 
						AND (config->>'unitId')::integer = ?`,
						[currentTypeId, id, config.host, config.port, config.unitId]
					);

					if (existing.length > 0) {
						throw new Error("已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）");
					}
				}
			}

			// 對於 sensor (modbus) 類型的設備，處理連接資訊和自動生成 unitId
			if (typeCode === "sensor" && config.protocol === "modbus") {
				const existingConfig = parseConfig(existingDevice.config);
				const finalModelId = model_id !== undefined ? model_id : existingDevice.model_id;

				// 獲取 model port
				let modelPort = null;
				if (finalModelId) {
					const models = await db.query("SELECT port FROM device_models WHERE id = ?", [finalModelId]);
					if (models.length > 0) {
						modelPort = models[0].port;
					}
				}

				// 設定 port（優先使用 config.port，否則使用 model.port，最後使用現有 port，最後預設 502）
				const finalPort = config.port !== undefined ? config.port : (modelPort || existingConfig?.port || 502);
				config.port = finalPort;

				// 自動生成 unitId（如果未提供且 host 或 port 有變更）
				if (config.unitId === undefined) {
					const finalHost = config.host || existingConfig?.host;
					
					if (finalHost && finalPort) {
						// 查詢相同 host + port 的設備，找出已使用的 unitId（排除當前設備）
						const existingDevices = await db.query(
							`SELECT config FROM devices 
							WHERE type_id = ? 
							AND id != ?
							AND config->>'protocol' = 'modbus'
							AND config->>'host' = ? 
							AND (config->>'port')::integer = ?`,
							[currentTypeId, id, finalHost, finalPort]
						);

						// 找出已使用的 unitId
						const usedUnitIds = new Set();
						existingDevices.forEach((device) => {
							const deviceConfig = parseConfig(device.config);
							if (deviceConfig && deviceConfig.protocol === "modbus" && deviceConfig.unitId !== undefined) {
								usedUnitIds.add(deviceConfig.unitId);
							}
						});

						// 如果現有設備有 unitId，優先使用
						if (existingConfig && existingConfig.protocol === "modbus" && existingConfig.unitId !== undefined) {
							if (!usedUnitIds.has(existingConfig.unitId)) {
								config.unitId = existingConfig.unitId;
							} else {
								// 現有的 unitId 已被使用，找新的
								let autoUnitId = 1;
								while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
									autoUnitId++;
								}
								if (autoUnitId > 255) {
									throw new Error("無法自動生成 unitId：已達到最大值 255");
								}
								config.unitId = autoUnitId;
							}
						} else {
							// 從 1 開始找第一個未使用的 unitId
							let autoUnitId = 1;
							while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
								autoUnitId++;
							}
							if (autoUnitId > 255) {
								throw new Error("無法自動生成 unitId：已達到最大值 255");
							}
							config.unitId = autoUnitId;
						}
					}
				}

				// 檢查是否已有相同連接配置的設備（host + port + unitId，排除當前設備）
				if (config.host && config.port !== undefined && config.unitId !== undefined) {
					const existing = await db.query(
						`SELECT id FROM devices 
						WHERE type_id = ? 
						AND id != ?
						AND config->>'host' = ? 
						AND (config->>'port')::integer = ? 
						AND (config->>'unitId')::integer = ?`,
						[currentTypeId, id, config.host, config.port, config.unitId]
					);

					if (existing.length > 0) {
						throw new Error("已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）");
					}
				}
			}

			updates.push("config = ?");
			params.push(stringifyConfig(config));
		}

		if (updates.length === 0) {
			throw new Error("沒有提供要更新的欄位");
		}

		params.push(id);

		// 記錄舊狀態（用於狀態變更事件）
		const oldStatus = existingDevice.status;

		await db.query(`UPDATE devices SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);

		// 取得更新後的設備
		const updatedDevice = await getDeviceById(id);
		
		// 構建變更的欄位列表
		const changes = {};
		const fields = { name, type_id, model_id, description, status, config };
		Object.keys(fields).forEach(key => {
			if (fields[key] !== undefined) {
				changes[key] = true;
			}
		});
		
		// 檢測狀態變更並推送特定事件
		const newStatus = status !== undefined ? status : oldStatus;
		if (status !== undefined && oldStatus !== newStatus) {
			websocketService.emitDeviceStatusChanged({
				deviceId: id,
				oldStatus,
				newStatus,
				userId,
			});
		}
		
		// 推送設備更新事件（包含所有變更）
		websocketService.emitDeviceUpdated({
			device: updatedDevice.device,
			changes,
			userId,
		});
		
		return updatedDevice;
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("更新設備失敗:", error);
		throw new Error("更新設備失敗: " + error.message);
	}
}

// 刪除設備
async function deleteDevice(id, userId = null) {
	try {
		// 檢查設備是否存在
		const devices = await db.query("SELECT id FROM devices WHERE id = ?", [id]);
		if (devices.length === 0) {
			const error = new Error("設備不存在");
			error.statusCode = 404;
			throw error;
		}

		await db.query("DELETE FROM devices WHERE id = ?", [id]);

		// 推送 WebSocket 事件：設備刪除
		websocketService.emitDeviceDeleted({
			deviceId: id,
			userId,
		});

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
