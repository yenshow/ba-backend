const db = require("../database/db");

// 驗證 IP 格式
function validateIP(ip) {
	const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
	if (!ipRegex.test(ip)) {
		throw new Error("IP 位址格式不正確");
	}
}

// 驗證端口
function validatePort(port) {
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error("端口必須是 1-65535 之間的整數");
	}
}

// 驗證 Unit ID
function validateUnitId(unitId) {
	if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) {
		throw new Error("Unit ID 必須是 0-255 之間的整數");
	}
}

// 驗證狀態
function validateStatus(status) {
	const validStatuses = ["active", "inactive", "error"];
	if (status && !validStatuses.includes(status)) {
		throw new Error(`狀態必須為 ${validStatuses.join(", ")} 其中之一`);
	}
}

// 構建設備查詢條件
function buildDeviceQueryConditions(filters) {
	let whereClause = "WHERE 1=1";
	const params = [];

	if (filters.status) {
		whereClause += " AND d.status = ?";
		params.push(filters.status);
	}

	if (filters.type_id) {
		whereClause += " AND d.type_id = ?";
		params.push(filters.type_id);
	}

	if (filters.model_id) {
		whereClause += " AND d.model_id = ?";
		params.push(filters.model_id);
	}

	return { whereClause, params };
}

// 建立 Modbus 設備
async function createDevice(deviceData, userId) {
	// 支援前端發送的欄位名稱（host, port, unitId）和後端欄位名稱（modbus_host, modbus_port, modbus_unit_id）
	const {
		name,
		model_id,
		type_id,
		device_type: device_type_from_data,
		host,
		modbus_host,
		port,
		modbus_port,
		port_id,
		unitId,
		modbus_unit_id,
		location,
		description,
		status = "inactive"
	} = deviceData;

	// 統一使用後端欄位名稱（port 會從 model 繼承，這裡先不處理）
	const finalHost = modbus_host || host;
	const finalUnitId = modbus_unit_id !== undefined ? modbus_unit_id : unitId;

	// 驗證必填欄位：model_id 是必填的
	if (!name || !model_id || !finalHost || finalUnitId === undefined) {
		throw new Error("name, model_id, host (或 modbus_host), unitId (或 modbus_unit_id) 為必填欄位");
	}

	// 驗證 IP 格式
	validateIP(finalHost);

	// 驗證 Unit ID
	validateUnitId(finalUnitId);

	// 驗證狀態
	if (status) {
		validateStatus(status);
	}

	// 檢查型號是否存在並獲取型號資訊（包含 type_id 和 port）
	const models = await db.query("SELECT id, type_id, port FROM modbus_device_models WHERE id = ?", [model_id]);
	if (models.length === 0) {
		throw new Error("設備型號不存在");
	}
	const model = models[0];
	
	// 從型號繼承 type_id 和 port
	const finalTypeId = type_id || model.type_id;
	const finalPort = modbus_port !== undefined ? modbus_port : (port !== undefined ? port : model.port);

	// 驗證端口
	validatePort(finalPort);

	// 檢查類型是否存在並取得 code
	const types = await db.query("SELECT id, code FROM modbus_device_types WHERE id = ?", [finalTypeId]);
	if (types.length === 0) {
		throw new Error("設備類型不存在");
	}
	const device_type = types[0].code;

	// 檢查端口是否存在（如果提供）
	if (port_id) {
		const ports = await db.query("SELECT id FROM modbus_ports WHERE id = ?", [port_id]);
		if (ports.length === 0) {
			throw new Error("端口不存在");
		}
	}

	// 檢查是否已有相同連接配置的設備（host + port + unitId）
	const existing = await db.query(
		"SELECT id FROM devices WHERE modbus_host = ? AND modbus_port = ? AND modbus_unit_id = ?",
		[finalHost, finalPort, finalUnitId]
	);
	if (existing.length > 0) {
		throw new Error("已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）");
	}

	// 建立設備（端口從型號繼承，type_id 也從型號繼承）
	const finalDeviceType = device_type_from_data || device_type;
	const insertFields = ["name", "model_id", "type_id", "device_type", "modbus_host", "modbus_port", "port_id", "modbus_unit_id", "location", "description", "status", "created_by"];
	const insertValues = [name, model_id, finalTypeId, finalDeviceType || null, finalHost, finalPort, port_id || null, finalUnitId, location || null, description || null, status, userId || null];
	
	const result = await db.query(
		`INSERT INTO devices (${insertFields.join(", ")}) VALUES (${insertFields.map(() => "?").join(", ")})`,
		insertValues
	);

	// 取得建立的設備（包含關聯資料）
	return await getDeviceById(result.insertId);
}

// 取得設備列表
async function getDevices(filters = {}) {
	const { status, type_id, model_id, limit, offset, orderBy, order } = filters;

	// 確保 limit 和 offset 是有效的整數
	const parsedLimit = limit !== undefined && limit !== null ? Math.max(1, Math.floor(Number(limit))) : 100;
	const parsedOffset = offset !== undefined && offset !== null ? Math.max(0, Math.floor(Number(offset))) : 0;

	// 構建查詢條件
	const { whereClause, params } = buildDeviceQueryConditions({ status, type_id, model_id });

	// 處理排序：預設按 created_at 降序（新到舊）
	const validOrderBy = ["id", "created_at", "name", "modbus_host"].includes(orderBy) ? orderBy : "created_at";
	const validOrder = order === "asc" || order === "desc" ? order : "desc";

	// 查詢設備列表（包含關聯資料）
	const query = `
    SELECT 
      d.id,
      d.name,
      d.model_id,
      d.type_id,
      d.modbus_host as host,
      d.modbus_port as port,
      d.port_id,
      d.modbus_unit_id as unitId,
      d.location,
      d.description,
      d.status,
      d.last_seen_at,
      d.created_by,
      d.created_at,
      d.updated_at,
      m.name as model_name,
      m.manufacturer as model_manufacturer,
      t.name as type_name,
      t.code as type_code,
      p.port as port_number,
      p.name as port_name
    FROM devices d
    LEFT JOIN modbus_device_models m ON d.model_id = m.id
    LEFT JOIN modbus_device_types t ON d.type_id = t.id
    LEFT JOIN modbus_ports p ON d.port_id = p.id
    ${whereClause}
    ORDER BY d.${validOrderBy} ${validOrder}
    LIMIT ${parsedLimit} OFFSET ${parsedOffset}
  `;

	const devices = await db.query(query, params);

	// 取得總數
	const countQuery = `SELECT COUNT(*) as total FROM devices d ${whereClause}`;
	const countResult = await db.query(countQuery, params);
	const total = countResult[0].total;

	return {
		devices,
		total,
		limit: parsedLimit,
		offset: parsedOffset
	};
}

// 取得單一設備
async function getDeviceById(deviceId) {
	const devices = await db.query(
		`
    SELECT 
      d.id,
      d.name,
      d.model_id,
      d.type_id,
      d.modbus_host as host,
      d.modbus_port as port,
      d.port_id,
      d.modbus_unit_id as unitId,
      d.location,
      d.description,
      d.status,
      d.last_seen_at,
      d.created_by,
      d.created_at,
      d.updated_at,
      m.name as model_name,
      m.manufacturer as model_manufacturer,
      t.name as type_name,
      t.code as type_code,
      p.port as port_number,
      p.name as port_name
    FROM devices d
    LEFT JOIN modbus_device_models m ON d.model_id = m.id
    LEFT JOIN modbus_device_types t ON d.type_id = t.id
    LEFT JOIN modbus_ports p ON d.port_id = p.id
    WHERE d.id = ?
  `,
		[deviceId]
	);

	if (devices.length === 0) {
		throw new Error("設備不存在");
	}

	return devices[0];
}

// 更新設備
async function updateDevice(deviceId, updateData, userId) {
	// 支援前端發送的欄位名稱（host, port, unitId）和後端欄位名稱（modbus_host, modbus_port, modbus_unit_id）
	const {
		name,
		model_id,
		type_id,
		host,
		modbus_host,
		port,
		modbus_port,
		port_id,
		unitId,
		modbus_unit_id,
		location,
		description,
		status
	} = updateData;

	// 統一使用後端欄位名稱（如果提供則使用，否則為 undefined）
	const finalHost = modbus_host !== undefined ? modbus_host : host;
	const finalUnitId = modbus_unit_id !== undefined ? modbus_unit_id : unitId;

	// 檢查設備是否存在
	const existingDevice = await getDeviceById(deviceId);

	// 驗證 IP 格式（如果提供）
	if (finalHost !== undefined) {
		validateIP(finalHost);
	}

	// 驗證 Unit ID（如果提供）
	if (finalUnitId !== undefined) {
		validateUnitId(finalUnitId);
	}

	// 驗證狀態（如果提供）
	if (status !== undefined) {
		validateStatus(status);
	}

	// 處理 model_id：如果更新 model_id，從型號獲取 type_id 和 port
	let finalModelId = model_id !== undefined ? model_id : existingDevice.model_id;
	let finalTypeId = type_id;
	let finalPort;
	let device_type;

	if (finalModelId) {
		// 檢查型號是否存在並獲取型號資訊
		const models = await db.query("SELECT id, type_id, port FROM modbus_device_models WHERE id = ?", [finalModelId]);
		if (models.length === 0) {
			throw new Error("設備型號不存在");
		}
		const model = models[0];
		// 從型號繼承 type_id 和 port（端口由型號綁定，不可手動修改）
		finalTypeId = type_id || model.type_id;
		// 如果更新了 model_id，強制使用型號的 port；否則如果提供了 port，使用提供的值；否則使用型號的 port
		if (model_id !== undefined && model_id !== existingDevice.model_id) {
			// 更新型號時，強制使用型號的端口
			finalPort = model.port;
		} else {
			// 沒有更新型號，但可以手動提供端口（向後兼容）
			finalPort = modbus_port !== undefined ? modbus_port : (port !== undefined ? port : model.port);
		}
	} else {
		// 如果沒有 model_id，使用原有的邏輯（向後兼容）
		finalPort = modbus_port !== undefined ? modbus_port : (port !== undefined ? port : existingDevice.port);
		if (finalTypeId) {
			const types = await db.query("SELECT id, code FROM modbus_device_types WHERE id = ?", [finalTypeId]);
			if (types.length === 0) {
				throw new Error("設備類型不存在");
			}
			device_type = types[0].code;
		}
	}

	// 如果從型號獲取了 type_id，獲取對應的 device_type
	if (finalTypeId && !device_type) {
		const types = await db.query("SELECT id, code FROM modbus_device_types WHERE id = ?", [finalTypeId]);
		if (types.length === 0) {
			throw new Error("設備類型不存在");
		}
		device_type = types[0].code;
	}

	// 驗證端口（從型號繼承或手動提供）
	if (finalPort !== undefined) {
		validatePort(finalPort);
	}

	// 檢查端口是否存在（如果提供）
	if (port_id !== undefined && port_id !== null) {
		const ports = await db.query("SELECT id FROM modbus_ports WHERE id = ?", [port_id]);
		if (ports.length === 0) {
			throw new Error("端口不存在");
		}
	}

	// 檢查是否已有相同連接配置的設備（如果修改了連接參數）
	// 注意：existingDevice 返回的欄位是 host, port, unitId（已映射）
	const checkHost = finalHost !== undefined ? finalHost : existingDevice.host;
	const checkPort = finalPort !== undefined ? finalPort : existingDevice.port;
	const checkUnitId = finalUnitId !== undefined ? finalUnitId : existingDevice.unitId;

	if (checkHost !== existingDevice.host || checkPort !== existingDevice.port || checkUnitId !== existingDevice.unitId) {
		const existing = await db.query(
			"SELECT id FROM devices WHERE modbus_host = ? AND modbus_port = ? AND modbus_unit_id = ? AND id != ?",
			[checkHost, checkPort, checkUnitId, deviceId]
		);
		if (existing.length > 0) {
			throw new Error("已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）");
		}
	}

	// 構建更新語句
	const updates = [];
	const params = [];

	if (name !== undefined) {
		updates.push("name = ?");
		params.push(name);
	}

	if (finalModelId !== undefined) {
		updates.push("model_id = ?");
		params.push(finalModelId || null);
	}

	// 如果從型號獲取了 type_id，更新它
	if (finalTypeId !== undefined && finalTypeId !== existingDevice.type_id) {
		updates.push("type_id = ?");
		params.push(finalTypeId);
	}

	// 如果從型號獲取了 device_type，更新它
	if (device_type !== undefined) {
		updates.push("device_type = ?");
		params.push(device_type);
	}

	if (finalHost !== undefined) {
		updates.push("modbus_host = ?");
		params.push(finalHost);
	}

	// 端口從型號繼承，如果型號有變更，必須更新端口
	if (finalPort !== undefined && finalPort !== existingDevice.port) {
		updates.push("modbus_port = ?");
		params.push(finalPort);
	}

	if (port_id !== undefined) {
		updates.push("port_id = ?");
		params.push(port_id || null);
	}

	if (finalUnitId !== undefined) {
		updates.push("modbus_unit_id = ?");
		params.push(finalUnitId);
	}

	if (location !== undefined) {
		updates.push("location = ?");
		params.push(location || null);
	}

	if (description !== undefined) {
		updates.push("description = ?");
		params.push(description || null);
	}

	if (status !== undefined) {
		updates.push("status = ?");
		params.push(status);
	}

	if (updates.length === 0) {
		return await getDeviceById(deviceId);
	}

	params.push(deviceId);
	await db.query(`UPDATE devices SET ${updates.join(", ")} WHERE id = ?`, params);

	return await getDeviceById(deviceId);
}

// 刪除設備
async function deleteDevice(deviceId) {
	// 檢查設備是否存在
	await getDeviceById(deviceId);

	// 刪除設備（外鍵約束會自動處理相關資料，如 addresses、logs、alerts）
	await db.query("DELETE FROM devices WHERE id = ?", [deviceId]);

	return { message: "設備已刪除" };
}

module.exports = {
	createDevice,
	getDevices,
	getDeviceById,
	updateDevice,
	deleteDevice
};

