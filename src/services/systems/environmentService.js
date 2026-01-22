const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const locationService = require("./locationService");

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

// 儲存感測器讀數（已廢棄：改由後端監控服務自動記錄到 device_data_logs）
// 保留此函數僅用於向後兼容，實際上資料已由 environmentMonitor 自動記錄
async function saveReading(readingData) {
	try {
		const { locationId, timestamp, data } = readingData;

		// 驗證必填欄位
		if (!locationId) {
			throw new Error("locationId 不能為空");
		}

		// 注意：此函數已廢棄，資料記錄已改由後端監控服務自動處理
		// 為了向後兼容，僅推送 WebSocket 事件（如果有需要）
		// 實際資料儲存應透過 device_data_logs 進行

		// 推送 WebSocket 事件：環境感測器讀數（廣播給所有客戶端）
		// 注意：如果後端監控服務已推送，這裡可能造成重複推送
		websocketService.emitEnvironmentReading({
			locationId: parseInt(locationId),
			reading: {
				id: `temp_${Date.now()}`,
				locationId: String(locationId),
				timestamp: timestamp || new Date().toISOString(),
				data: data || {},
				createdAt: new Date().toISOString(),
			},
		});

		return {
			message: "讀數已推送（資料記錄由後端自動處理）",
			reading: {
				id: `temp_${Date.now()}`,
				locationId: String(locationId),
				timestamp: timestamp || new Date().toISOString(),
				data: data || {},
				createdAt: new Date().toISOString(),
			},
		};
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		console.error("推送讀數失敗:", error);
		throw new Error("推送讀數失敗: " + error.message);
	}
}

// 取得歷史讀數（從 device_data_logs 聚合）
async function getReadings(locationId, options = {}) {
	try {
		const { startTime, endTime, limit = 1000 } = options;

		// 驗證位置是否存在且具有環境監測系統，並取得 device_id
		const locationInfo = await db.query(
			`SELECT 
				l.id as location_id,
				ls.system_config->>'device_id' as device_id
			FROM locations l
			INNER JOIN location_systems ls ON l.id = ls.location_id
			WHERE l.id = $1 AND ls.system_type = 'environment'`,
			[parseInt(locationId)]
		);
		
		if (locationInfo.length === 0 || !locationInfo[0].device_id) {
			const error = new Error("位置不存在或未配置環境監測系統");
			error.statusCode = 404;
			throw error;
		}

		const deviceId = parseInt(locationInfo[0].device_id);

		// 從 device_data_logs 查詢並按時間點聚合
		// 使用時間窗口（每5秒）聚合相近時間的記錄，確保批次寫入的記錄能被正確聚合
		let query = `
			SELECT 
				date_trunc('second', recorded_at) as timestamp,
				jsonb_object_agg(
					value->>'name',
					(value->>'value')::numeric
				) as data
			FROM device_data_logs
			WHERE device_id = $1
		`;
		const params = [deviceId];
		let paramIndex = 2;

		if (startTime) {
			query += ` AND recorded_at >= $${paramIndex++}`;
			params.push(new Date(startTime));
		}

		if (endTime) {
			query += ` AND recorded_at <= $${paramIndex++}`;
			params.push(new Date(endTime));
		}

		query += ` 
			GROUP BY date_trunc('second', recorded_at)
			ORDER BY timestamp ASC 
			LIMIT $${paramIndex}`;
		params.push(limit);

		const readings = await db.query(query, params);

		return {
			readings: readings.map((reading, index) => ({
				id: `device_log_${deviceId}_${reading.timestamp.getTime()}`,
				locationId: String(locationId),
				timestamp: reading.timestamp.toISOString(),
				data: reading.data || {},
				createdAt: reading.timestamp.toISOString(),
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

