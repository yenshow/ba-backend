const db = require("../database/db");

/**
 * 取得警示列表
 * @param {Object} filters - 篩選條件
 * @returns {Promise<Object>} 警示列表和總數
 */
async function getAlerts(filters = {}) {
	try {
		const {
			device_id,
			alert_type,
			severity,
			resolved,
			limit = 50,
			offset = 0,
			orderBy = "created_at",
			order = "desc"
		} = filters;

		let query = `
			SELECT 
				da.*,
				d.name as device_name,
				d.type_id,
				dt.name as device_type_name,
				dt.code as device_type_code,
				u.username as resolved_by_username
			FROM device_alerts da
			INNER JOIN devices d ON da.device_id = d.id
			INNER JOIN device_types dt ON d.type_id = dt.id
			LEFT JOIN users u ON da.resolved_by = u.id
			WHERE 1=1
		`;
		const params = [];

		if (device_id) {
			query += " AND da.device_id = ?";
			params.push(device_id);
		}

		if (alert_type) {
			query += " AND da.alert_type = ?";
			params.push(alert_type);
		}

		if (severity) {
			query += " AND da.severity = ?";
			params.push(severity);
		}

		if (resolved !== undefined) {
			query += " AND da.resolved = ?";
			params.push(resolved);
		}

		// 排序
		const validOrderBy = ["created_at", "updated_at", "severity", "alert_type"];
		const orderByField = validOrderBy.includes(orderBy) ? orderBy : "created_at";
		const orderDirection = order.toLowerCase() === "asc" ? "ASC" : "DESC";
		query += ` ORDER BY da.${orderByField} ${orderDirection}`;

		// 分頁
		query += " LIMIT ? OFFSET ?";
		params.push(parseInt(limit), parseInt(offset));

		const alerts = await db.query(query, params);

		// 取得總數
		let countQuery = `
			SELECT COUNT(*) as total
			FROM device_alerts da
			WHERE 1=1
		`;
		const countParams = [];

		if (device_id) {
			countQuery += " AND da.device_id = ?";
			countParams.push(device_id);
		}

		if (alert_type) {
			countQuery += " AND da.alert_type = ?";
			countParams.push(alert_type);
		}

		if (severity) {
			countQuery += " AND da.severity = ?";
			countParams.push(severity);
		}

		if (resolved !== undefined) {
			countQuery += " AND da.resolved = ?";
			countParams.push(resolved);
		}

		const countResult = await db.query(countQuery, countParams);
		const total = parseInt(countResult[0]?.total || 0);

		return {
			alerts: alerts || [],
			total,
			limit: parseInt(limit),
			offset: parseInt(offset)
		};
	} catch (error) {
		console.error("[alertService] 取得警示列表失敗:", error);
		throw error;
	}
}

/**
 * 取得單一警示
 * @param {number} id - 警示 ID
 * @returns {Promise<Object>} 警示資料
 */
async function getAlertById(id) {
	try {
		const query = `
			SELECT 
				da.*,
				d.name as device_name,
				d.type_id,
				dt.name as device_type_name,
				dt.code as device_type_code,
				u.username as resolved_by_username
			FROM device_alerts da
			INNER JOIN devices d ON da.device_id = d.id
			INNER JOIN device_types dt ON d.type_id = dt.id
			LEFT JOIN users u ON da.resolved_by = u.id
			WHERE da.id = ?
		`;
		const result = await db.query(query, [id]);

		if (!result || result.length === 0) {
			throw new Error(`警示 ID ${id} 不存在`);
		}

		return result[0];
	} catch (error) {
		console.error(`[alertService] 取得警示 ${id} 失敗:`, error);
		throw error;
	}
}

/**
 * 創建警示
 * @param {Object} alertData - 警示資料
 * @returns {Promise<Object>} 創建的警示
 */
async function createAlert(alertData) {
	try {
		const { device_id, alert_type, severity = "warning", message } = alertData;

		if (!device_id || !alert_type || !message) {
			throw new Error("device_id、alert_type 和 message 為必填欄位");
		}

		// 驗證 alert_type
		const validAlertTypes = ["offline", "error", "threshold", "maintenance"];
		if (!validAlertTypes.includes(alert_type)) {
			throw new Error(`無效的 alert_type: ${alert_type}`);
		}

		// 驗證 severity
		const validSeverities = ["info", "warning", "error", "critical"];
		if (!validSeverities.includes(severity)) {
			throw new Error(`無效的 severity: ${severity}`);
		}

		// 檢查設備是否存在
		const deviceCheck = await db.query("SELECT id FROM devices WHERE id = ?", [device_id]);
		if (!deviceCheck || deviceCheck.length === 0) {
			throw new Error(`設備 ID ${device_id} 不存在`);
		}

		const query = `
			INSERT INTO device_alerts (device_id, alert_type, severity, message)
			VALUES (?, ?, ?, ?)
			RETURNING *
		`;
		const result = await db.query(query, [device_id, alert_type, severity, message]);

		return result[0];
	} catch (error) {
		console.error("[alertService] 創建警示失敗:", error);
		throw error;
	}
}

/**
 * 標記警示為已解決
 * @param {number} id - 警示 ID
 * @param {number} resolvedBy - 解決者用戶 ID
 * @returns {Promise<Object>} 更新後的警示
 */
async function resolveAlert(id, resolvedBy) {
	try {
		const query = `
			UPDATE device_alerts
			SET resolved = TRUE,
					resolved_at = CURRENT_TIMESTAMP,
					resolved_by = ?
			WHERE id = ?
			RETURNING *
		`;
		const result = await db.query(query, [resolvedBy, id]);

		if (!result || result.length === 0) {
			throw new Error(`警示 ID ${id} 不存在`);
		}

		return result[0];
	} catch (error) {
		console.error(`[alertService] 解決警示 ${id} 失敗:`, error);
		throw error;
	}
}

/**
 * 標記警示為未解決
 * @param {number} id - 警示 ID
 * @returns {Promise<Object>} 更新後的警示
 */
async function unresolveAlert(id) {
	try {
		const query = `
			UPDATE device_alerts
			SET resolved = FALSE,
					resolved_at = NULL,
					resolved_by = NULL
			WHERE id = ?
			RETURNING *
		`;
		const result = await db.query(query, [id]);

		if (!result || result.length === 0) {
			throw new Error(`警示 ID ${id} 不存在`);
		}

		return result[0];
	} catch (error) {
		console.error(`[alertService] 取消解決警示 ${id} 失敗:`, error);
		throw error;
	}
}

/**
 * 刪除警示
 * @param {number} id - 警示 ID
 * @returns {Promise<boolean>} 是否成功刪除
 */
async function deleteAlert(id) {
	try {
		const query = "DELETE FROM device_alerts WHERE id = ? RETURNING id";
		const result = await db.query(query, [id]);

		if (!result || result.length === 0) {
			throw new Error(`警示 ID ${id} 不存在`);
		}

		return true;
	} catch (error) {
		console.error(`[alertService] 刪除警示 ${id} 失敗:`, error);
		throw error;
	}
}

/**
 * 取得未解決的警示數量
 * @param {Object} filters - 可選的篩選條件
 * @returns {Promise<number>} 未解決的警示數量
 */
async function getUnresolvedAlertCount(filters = {}) {
	try {
		const { device_id, alert_type, severity } = filters;

		let query = `
			SELECT COUNT(*) as count
			FROM device_alerts
			WHERE resolved = FALSE
		`;
		const params = [];

		if (device_id) {
			query += " AND device_id = ?";
			params.push(device_id);
		}

		if (alert_type) {
			query += " AND alert_type = ?";
			params.push(alert_type);
		}

		if (severity) {
			query += " AND severity = ?";
			params.push(severity);
		}

		const result = await db.query(query, params);
		return parseInt(result[0]?.count || 0);
	} catch (error) {
		console.error("[alertService] 取得未解決警示數量失敗:", error);
		throw error;
	}
}

module.exports = {
	getAlerts,
	getAlertById,
	createAlert,
	resolveAlert,
	unresolveAlert,
	deleteAlert,
	getUnresolvedAlertCount
};

