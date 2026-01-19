const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const locationService = require("./locationService");

// 注意：formatLocation, formatFloor, loadFloorLocations, validateAndCreateLocation, validateAndUpdateLocation 
// 等函數已移除，統一使用 locationService 處理

// ========== 區域管理函數 ==========

// 取得區域列表（使用統一表）
async function getZones() {
	try {
		const result = await locationService.getZones({ locationType: "environment" });
		return { zones: result.zones };
	} catch (error) {
		console.error("取得區域列表失敗:", error);
		throw new Error("取得區域列表失敗: " + error.message);
	}
}

// 取得單一區域（使用統一表）
async function getZoneById(id) {
	try {
		const result = await locationService.getZoneById(id, "environment");
		return { zone: result.zone };
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("取得區域失敗:", error);
		throw new Error("取得區域失敗: " + error.message);
	}
}

// 建立區域（使用統一表）
async function createZone(zoneData, userId) {
	try {
		const { name, locations = [] } = zoneData;

		// 將 locations 轉換為統一格式（加入 locationType）
		const unifiedLocations = locations.map((loc) => ({
			...loc,
			locationType: "environment",
		}));

		const result = await locationService.createZone(
			{
				...zoneData,
				locations: unifiedLocations,
			},
			userId
		);
		return {
			merged: result.merged,
			message: result.message,
			zone: result.zone,
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("建立區域失敗:", error);
		throw new Error("建立區域失敗: " + error.message);
	}
}

// 更新區域（使用統一表）
async function updateZone(id, zoneData, userId) {
	try {
		const { name, locations } = zoneData;

		// 將 locations 轉換為統一格式（加入 locationType）
		const unifiedLocations = locations
			? locations.map((loc) => ({
					...loc,
					locationType: "environment",
			  }))
			: undefined;

		const result = await locationService.updateZone(
			id,
			{
				...(name !== undefined && { name }),
				locations: unifiedLocations,
			},
			userId
		);
		return {
			merged: result.merged,
			message: result.message,
			zone: result.zone,
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("更新區域失敗:", error);
		throw new Error("更新區域失敗: " + error.message);
	}
}

// 刪除區域（使用統一表）
async function deleteZone(id) {
	try {
		return await locationService.deleteZone(id);
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("刪除區域失敗:", error);
		throw new Error("刪除區域失敗: " + error.message);
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

		// 驗證位置是否存在且具有環境監測系統（檢查統一表）
		const locations = await db.query(
			`SELECT l.id FROM locations l
			 INNER JOIN location_systems ls ON l.id = ls.location_id
			 WHERE l.id = $1 AND ls.system_type = 'environment'`,
			[parseInt(locationId)]
		);
		if (locations.length === 0) {
			const error = new Error("位置不存在或未配置環境監測系統");
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

		const reading = {
			id: String(result[0].id),
			locationId: String(result[0].location_id),
			timestamp: result[0].timestamp.toISOString(),
			data: typeof result[0].data === "string" ? JSON.parse(result[0].data) : result[0].data,
			createdAt: result[0].created_at.toISOString(),
		};

		// 推送 WebSocket 事件：環境感測器讀數（廣播給所有客戶端）
		websocketService.emitEnvironmentReading({
			locationId: parseInt(locationId),
			reading,
		});

		return {
			message: "讀數儲存成功",
			reading,
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

		// 驗證位置是否存在且具有環境監測系統（檢查統一表）
		const locations = await db.query(
			`SELECT l.id FROM locations l
			 INNER JOIN location_systems ls ON l.id = ls.location_id
			 WHERE l.id = $1 AND ls.system_type = 'environment'`,
			[parseInt(locationId)]
		);
		if (locations.length === 0) {
			const error = new Error("位置不存在或未配置環境監測系統");
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
	// 區域管理
	getZones,
	getZoneById,
	createZone,
	updateZone,
	deleteZone,
	// 感測器讀數
	saveReading,
	getReadings,
};

