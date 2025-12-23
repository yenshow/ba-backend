const db = require("../../database/db");

// ========== 共用輔助函數 ==========

// 格式化位置資料為前端格式
// 注意：floor 欄位已移除，樓層資訊從父層級 EnvironmentFloor.name 取得
function formatLocation(location) {
	return {
		id: String(location.id),
		name: location.name,
		// floor 欄位已移除（冗餘），樓層資訊從 EnvironmentFloor.name 取得
		deviceId: location.device_id || undefined,
		parameters:
			location.parameters && Array.isArray(location.parameters)
				? typeof location.parameters === "string"
					? JSON.parse(location.parameters)
					: location.parameters
				: [],
	};
}

// 格式化樓層資料為前端格式
function formatFloor(floor, locations = []) {
	return {
		id: String(floor.id),
		name: floor.name,
		locations: locations.map(formatLocation),
	};
}

// 載入樓層的位置
async function loadFloorLocations(floorId) {
	const locations = await db.query(
		`SELECT el.*
     FROM environment_locations el
     WHERE el.floor_id = $1
     ORDER BY el.created_at ASC`,
		[floorId]
	);
	return locations;
}

// 驗證並建立位置（用於事務內部）
// 注意：floor 欄位已移除，樓層資訊從 floorId 對應的 environment_floors.name 取得
async function validateAndCreateLocation(query, floorId, location, userId) {
	const { name: locationName, deviceId, parameters = [] } = location;

	if (!locationName || locationName.trim().length === 0) {
		throw new Error("位置名稱不能為空");
	}

	// 驗證設備是否存在
	if (deviceId) {
		const devices = await query("SELECT id FROM devices WHERE id = $1", [deviceId]);
		if (devices.length === 0) {
			throw new Error(`設備 ID ${deviceId} 不存在`);
		}
	}

	// 驗證參數陣列
	if (!Array.isArray(parameters)) {
		throw new Error("參數列表必須為陣列");
	}

	// 驗證每個參數的結構（新格式：只需要 type 和 enabled）
	const validParameterTypes = ["pm25", "pm10", "tvoc", "hcho", "humidity", "temperature", "co2", "noise", "wind"];
	for (const param of parameters) {
		if (!param.type) {
			throw new Error("參數必須包含 type 欄位");
		}
		if (!validParameterTypes.includes(param.type)) {
			throw new Error(`無效的參數類型: ${param.type}。有效類型: ${validParameterTypes.join(", ")}`);
		}
		if (typeof param.enabled !== "boolean") {
			throw new Error("參數的 enabled 欄位必須為布林值");
		}
		// 移除 label 和 unit 的驗證（這些由類型推導）
	}

	const result = await query(
		`INSERT INTO environment_locations 
     (floor_id, name, device_id, parameters, created_by) 
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
		[
			floorId,
			locationName.trim(),
			deviceId || null,
			JSON.stringify(parameters),
			userId || null,
		]
	);

	return result[0].id;
}

// 驗證並更新位置（用於事務內部）
// 注意：floor 欄位已移除，樓層資訊從 floor_id 對應的 environment_floors.name 取得
async function validateAndUpdateLocation(query, locationId, location, userId) {
	const { name: locationName, deviceId, parameters = [] } = location;

	if (!locationName || locationName.trim().length === 0) {
		throw new Error("位置名稱不能為空");
	}

	// 驗證設備是否存在
	if (deviceId) {
		const devices = await query("SELECT id FROM devices WHERE id = $1", [deviceId]);
		if (devices.length === 0) {
			throw new Error(`設備 ID ${deviceId} 不存在`);
		}
	}

	// 驗證參數陣列
	if (!Array.isArray(parameters)) {
		throw new Error("參數列表必須為陣列");
	}

	// 驗證每個參數的結構（新格式：只需要 type 和 enabled）
	const validParameterTypes = ["pm25", "pm10", "tvoc", "hcho", "humidity", "temperature", "co2", "noise", "wind"];
	for (const param of parameters) {
		if (!param.type) {
			throw new Error("參數必須包含 type 欄位");
		}
		if (!validParameterTypes.includes(param.type)) {
			throw new Error(`無效的參數類型: ${param.type}。有效類型: ${validParameterTypes.join(", ")}`);
		}
		if (typeof param.enabled !== "boolean") {
			throw new Error("參數的 enabled 欄位必須為布林值");
		}
		// 移除 label 和 unit 的驗證（這些由類型推導）
	}

	// 檢查位置是否存在
	const existing = await query("SELECT id FROM environment_locations WHERE id = $1", [locationId]);
	if (existing.length === 0) {
		throw new Error(`位置 ID ${locationId} 不存在`);
	}

	await query(
		`UPDATE environment_locations 
     SET name = $1, device_id = $2, 
         parameters = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $4`,
		[
			locationName.trim(),
			deviceId || null,
			JSON.stringify(parameters),
			locationId,
		]
	);
}

// ========== 樓層管理函數 ==========

// 取得樓層列表
async function getFloors() {
	try {
		const floors = await db.query(`SELECT * FROM environment_floors ORDER BY created_at DESC`);

		// 為每個樓層載入位置
		const floorsWithLocations = await Promise.all(
			floors.map(async (floor) => {
				const locations = await loadFloorLocations(floor.id);
				return formatFloor(floor, locations);
			})
		);

		return { floors: floorsWithLocations };
	} catch (error) {
		console.error("取得樓層列表失敗:", error);
		throw new Error("取得樓層列表失敗: " + error.message);
	}
}

// 取得單一樓層
async function getFloorById(id) {
	try {
		const floors = await db.query(`SELECT * FROM environment_floors WHERE id = $1`, [id]);

		if (floors.length === 0) {
			const error = new Error("樓層不存在");
			error.statusCode = 404;
			throw error;
		}

		const floor = floors[0];
		const locations = await loadFloorLocations(floor.id);

		return {
			floor: formatFloor(floor, locations),
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("取得樓層失敗:", error);
		throw new Error("取得樓層失敗: " + error.message);
	}
}

// 建立樓層
async function createFloor(floorData, userId) {
	try {
		const { name, locations = [] } = floorData;

		// 驗證必填欄位
		if (!name || name.trim().length === 0) {
			throw new Error("樓層名稱不能為空");
		}

		if (name.length > 100) {
			throw new Error("樓層名稱長度不能超過 100 字元");
		}

		// 使用事務確保樓層和位置一起建立
		const result = await db.transaction(async (query) => {
			// 建立樓層
			const floorResult = await query(
				`INSERT INTO environment_floors (name, created_by) 
         VALUES ($1, $2) 
         RETURNING id`,
				[name.trim(), userId || null]
			);

			const floorId = floorResult[0].id;

			// 建立位置
			for (const location of locations) {
				await validateAndCreateLocation(query, floorId, location, userId);
			}

			return floorId;
		});

		// 取得建立後的完整樓層資料
		const floorResult = await getFloorById(result);
		return {
			message: "樓層建立成功",
			floor: floorResult.floor,
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		// 處理唯一性約束錯誤
		if (error.code === "23505" && error.constraint === "environment_floors_name_key") {
			const duplicateError = new Error("樓層名稱已存在");
			duplicateError.statusCode = 400;
			throw duplicateError;
		}
		console.error("建立樓層失敗:", error);
		throw new Error("建立樓層失敗: " + error.message);
	}
}

// 更新樓層
async function updateFloor(id, floorData, userId) {
	try {
		const { name, locations } = floorData;

		// 檢查樓層是否存在
		const existing = await db.query("SELECT * FROM environment_floors WHERE id = $1", [id]);
		if (existing.length === 0) {
			const error = new Error("樓層不存在");
			error.statusCode = 404;
			throw error;
		}

		// 使用事務更新樓層和位置
		await db.transaction(async (query) => {
			// 更新樓層基本資訊
			const updates = [];
			const params = [];
			let paramIndex = 1;

			if (name !== undefined) {
				if (name.trim().length === 0) {
					throw new Error("樓層名稱不能為空");
				}
				if (name.length > 100) {
					throw new Error("樓層名稱長度不能超過 100 字元");
				}
				updates.push(`name = $${paramIndex++}`);
				params.push(name.trim());
			}


			if (updates.length > 0) {
				params.push(id);
				await query(
					`UPDATE environment_floors SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`,
					params
				);
			}

			// 處理位置更新（智能更新：保留 ID，更新/新增/刪除）
			if (locations !== undefined) {
				// 取得現有位置 ID 列表
				const existingLocations = await query(
					"SELECT id FROM environment_locations WHERE floor_id = $1",
					[id]
				);
				const existingLocationIds = new Set(existingLocations.map((l) => String(l.id)));

				// 處理每個位置
				const updatedLocationIds = new Set();
				for (const location of locations) {
					const locationId = location.id ? String(location.id) : null;

					if (locationId && existingLocationIds.has(locationId)) {
						// 更新現有位置（保留 ID）
						await validateAndUpdateLocation(query, parseInt(locationId), location, userId);
						updatedLocationIds.add(locationId);
					} else {
						// 建立新位置
						const newLocationId = await validateAndCreateLocation(query, id, location, userId);
						updatedLocationIds.add(String(newLocationId));
					}
				}

				// 刪除不在更新列表中的位置
				const locationsToDelete = Array.from(existingLocationIds).filter(
					(id) => !updatedLocationIds.has(id)
				);
				if (locationsToDelete.length > 0) {
					await query(`DELETE FROM environment_locations WHERE id = ANY($1::int[])`, [
						locationsToDelete.map((id) => parseInt(id)),
					]);
				}
			}
		});

		// 取得更新後的完整樓層資料
		const floorResult = await getFloorById(id);
		return {
			message: "樓層更新成功",
			floor: floorResult.floor,
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		// 處理唯一性約束錯誤
		if (error.code === "23505" && error.constraint === "environment_floors_name_key") {
			const duplicateError = new Error("樓層名稱已存在");
			duplicateError.statusCode = 400;
			throw duplicateError;
		}
		console.error("更新樓層失敗:", error);
		throw new Error("更新樓層失敗: " + error.message);
	}
}

// 刪除樓層
async function deleteFloor(id) {
	try {
		// 檢查樓層是否存在
		const floors = await db.query("SELECT id FROM environment_floors WHERE id = $1", [id]);
		if (floors.length === 0) {
			const error = new Error("樓層不存在");
			error.statusCode = 404;
			throw error;
		}

		// 刪除樓層（位置會自動級聯刪除）
		await db.query("DELETE FROM environment_floors WHERE id = $1", [id]);

		return { message: "樓層已刪除" };
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("刪除樓層失敗:", error);
		throw new Error("刪除樓層失敗: " + error.message);
	}
}

// ========== 感測器讀數管理函數 ==========

// 儲存感測器讀數
async function saveReading(readingData) {
	try {
		const { locationId, timestamp, data } = readingData;

		// 驗證必填欄位
		if (!locationId) {
			throw new Error("locationId 不能為空");
		}

		if (!timestamp) {
			throw new Error("timestamp 不能為空");
		}

		if (!data || typeof data !== "object") {
			throw new Error("data 必須為物件");
		}

		// 驗證位置是否存在
		const locations = await db.query("SELECT id FROM environment_locations WHERE id = $1", [
			parseInt(locationId),
		]);
		if (locations.length === 0) {
			const error = new Error("位置不存在");
			error.statusCode = 404;
			throw error;
		}

		// 儲存讀數
		const result = await db.query(
			`INSERT INTO sensor_readings (location_id, timestamp, data) 
       VALUES ($1, $2, $3) 
       RETURNING id, location_id, timestamp, data, created_at`,
			[parseInt(locationId), new Date(timestamp), JSON.stringify(data)]
		);

		return {
			message: "讀數儲存成功",
			reading: {
				id: String(result[0].id),
				locationId: String(result[0].location_id),
				timestamp: result[0].timestamp.toISOString(),
				data: typeof result[0].data === "string" ? JSON.parse(result[0].data) : result[0].data,
				createdAt: result[0].created_at.toISOString(),
			},
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("儲存讀數失敗:", error);
		throw new Error("儲存讀數失敗: " + error.message);
	}
}

// 取得歷史讀數
async function getReadings(locationId, options = {}) {
	try {
		const { startTime, endTime, limit = 1000 } = options;

		// 驗證位置是否存在
		const locations = await db.query("SELECT id FROM environment_locations WHERE id = $1", [
			parseInt(locationId),
		]);
		if (locations.length === 0) {
			const error = new Error("位置不存在");
			error.statusCode = 404;
			throw error;
		}

		// 建立查詢條件
		let query = `SELECT id, location_id, timestamp, data, created_at 
                 FROM sensor_readings 
                 WHERE location_id = $1`;
		const params = [parseInt(locationId)];
		let paramIndex = 2;

		if (startTime) {
			query += ` AND timestamp >= $${paramIndex++}`;
			params.push(new Date(startTime));
		}

		if (endTime) {
			query += ` AND timestamp <= $${paramIndex++}`;
			params.push(new Date(endTime));
		}

		query += ` ORDER BY timestamp ASC LIMIT $${paramIndex}`;
		params.push(limit);

		const readings = await db.query(query, params);

		return {
			readings: readings.map((reading) => ({
				id: String(reading.id),
				locationId: String(reading.location_id),
				timestamp: reading.timestamp.toISOString(),
				data: typeof reading.data === "string" ? JSON.parse(reading.data) : reading.data,
				createdAt: reading.created_at.toISOString(),
			})),
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("取得讀數失敗:", error);
		throw new Error("取得讀數失敗: " + error.message);
	}
}

module.exports = {
	// 樓層管理
	getFloors,
	getFloorById,
	createFloor,
	updateFloor,
	deleteFloor,
	// 感測器讀數
	saveReading,
	getReadings,
};

