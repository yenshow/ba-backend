const db = require("../../database/db");

/**
 * 統一警報服務
 * 支持多系統來源：device, environment, lighting 等
 */

// 警報系統來源
const ALERT_SOURCES = {
  DEVICE: "device",
  ENVIRONMENT: "environment",
  LIGHTING: "lighting",
  HVAC: "hvac",
  FIRE: "fire",
  SECURITY: "security",
};

// 警報狀態
const ALERT_STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  RESOLVED: "resolved",
  IGNORED: "ignored",
};

// 警報類型
const ALERT_TYPES = {
  OFFLINE: "offline",
  ERROR: "error",
  THRESHOLD: "threshold",
};

// 嚴重程度
const SEVERITIES = {
  WARNING: "warning",
  ERROR: "error",
  CRITICAL: "critical",
};

/**
 * 取得警報列表
 * @param {Object} filters - 篩選條件
 * @returns {Promise<Object>} 警報列表和總數
 */
async function getAlerts(filters = {}) {
  try {
    const {
      source,
      source_id,
      device_id, // 向後兼容
      device_type_code,
      alert_type,
      severity,
      status,
      resolved, // 向後兼容
      ignored, // 向後兼容
      start_date,
      end_date,
      limit = 50,
      offset = 0,
      orderBy = "created_at",
      order = "desc",
    } = filters;

    // 向後兼容：將 device_id 轉換為 source 和 source_id
    const actualSource =
      source || (device_id ? ALERT_SOURCES.DEVICE : undefined);
    const actualSourceId = source_id || device_id;

    // 向後兼容：將 resolved/ignored 轉換為 status
    let actualStatus = status;
    if (!actualStatus) {
      if (resolved === true) {
        actualStatus = ALERT_STATUS.RESOLVED;
      } else if (ignored === true) {
        actualStatus = ALERT_STATUS.IGNORED;
      } else if (resolved === false && ignored === false) {
        actualStatus = ALERT_STATUS.ACTIVE;
      }
    }

    // 合併相同來源、相同類型、相同狀態的警報
    let query = `
			SELECT 
				MIN(a.id) as id,
				a.source,
				a.source_id,
				a.source_type,
				a.alert_type,
				a.status,
				MAX(a.severity) as severity,
				MAX(a.message) as message,
				MAX(a.resolved_at) as resolved_at,
				MAX(a.resolved_by) as resolved_by,
				MAX(a.ignored_at) as ignored_at,
				MAX(a.ignored_by) as ignored_by,
				MIN(a.created_at) as created_at,
				MAX(a.created_at) as latest_created_at,
				(
					SELECT metadata 
					FROM alerts a2 
					WHERE a2.source = a.source 
						AND a2.source_id = a.source_id 
						AND a2.alert_type = a.alert_type 
						AND a2.status = a.status
					ORDER BY a2.created_at DESC 
					LIMIT 1
				) as metadata,
				COUNT(*) as alert_count,
				MAX(ru.username) as resolved_by_username,
				MAX(iu.username) as ignored_by_username,
				-- 設備資訊（僅適用於設備來源）
				MAX(CASE WHEN a.source = 'device' THEN d.name END) as device_name,
				MAX(CASE WHEN a.source = 'device' THEN dt.name END) as device_type_name,
				MAX(CASE WHEN a.source = 'device' THEN dt.code END) as device_type_code
			FROM alerts a
			LEFT JOIN users ru ON a.resolved_by = ru.id
			LEFT JOIN users iu ON a.ignored_by = iu.id
			LEFT JOIN devices d ON a.source = 'device' AND a.source_id = d.id
			LEFT JOIN device_types dt ON d.type_id = dt.id
			WHERE 1=1
		`;
    const params = [];

    // 應用篩選條件
    if (actualSource) {
      query += " AND a.source = ?";
      params.push(actualSource);
    }
    if (actualSourceId) {
      query += " AND a.source_id = ?";
      params.push(actualSourceId);
    }
    if (alert_type) {
      query += " AND a.alert_type = ?";
      params.push(alert_type);
    }
    if (severity) {
      query += " AND a.severity = ?";
      params.push(severity);
    }
    if (actualStatus) {
      query += " AND a.status = ?";
      params.push(actualStatus);
    }
    if (device_type_code && actualSource === ALERT_SOURCES.DEVICE) {
      // 如果是設備來源，需要 JOIN devices 表
      query += ` AND EXISTS (
				SELECT 1 FROM devices d
				INNER JOIN device_types dt ON d.type_id = dt.id
				WHERE d.id = a.source_id AND dt.code = ?
			)`;
      params.push(device_type_code);
    }
    if (start_date) {
      query += " AND a.created_at >= ?";
      params.push(start_date);
    }
    if (end_date) {
      query += " AND a.created_at <= ?";
      params.push(end_date);
    }

    // 按來源、來源ID、警報類型、狀態分組
    query += ` GROUP BY a.source, a.source_id, a.source_type, a.alert_type, a.status`;

    // 排序
    const validOrderBy = [
      "created_at",
      "latest_created_at",
      "severity",
      "alert_type",
      "status",
    ];
    const orderByField = validOrderBy.includes(orderBy)
      ? orderBy === "created_at"
        ? "MIN(a.created_at)"
        : orderBy
      : "MIN(a.created_at)";
    const orderDirection = order.toLowerCase() === "asc" ? "ASC" : "DESC";
    query += ` ORDER BY ${orderByField} ${orderDirection}`;

    // 分頁
    query += " LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const alerts = await db.query(query, params);

    // 取得總數
    const countParams = params.slice(0, -2);
    let countQuery = `
			SELECT COUNT(DISTINCT CONCAT(a.source::text, '-', a.source_id::text, '-', a.alert_type::text, '-', a.status::text)) as total
			FROM alerts a
			WHERE 1=1
		`;
    if (actualSource) countQuery += " AND a.source = ?";
    if (actualSourceId) countQuery += " AND a.source_id = ?";
    if (alert_type) countQuery += " AND a.alert_type = ?";
    if (severity) countQuery += " AND a.severity = ?";
    if (actualStatus) countQuery += " AND a.status = ?";
    if (device_type_code && actualSource === ALERT_SOURCES.DEVICE) {
      countQuery += ` AND EXISTS (
				SELECT 1 FROM devices d
				INNER JOIN device_types dt ON d.type_id = dt.id
				WHERE d.id = a.source_id AND dt.code = ?
			)`;
    }
    if (start_date) countQuery += " AND a.created_at >= ?";
    if (end_date) countQuery += " AND a.created_at <= ?";

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult[0]?.total || 0);

    // 為每個 alert 添加向後兼容的字段
    const enrichedAlerts = (alerts || []).map((alert) => {
      const enriched = { ...alert };
      
      // 向後兼容：添加 resolved 和 ignored 布爾值字段
      enriched.resolved = alert.status === ALERT_STATUS.RESOLVED;
      enriched.ignored = alert.status === ALERT_STATUS.IGNORED;
      
      // 向後兼容：如果是設備來源，添加 device_id 字段
      if (alert.source === ALERT_SOURCES.DEVICE) {
        enriched.device_id = alert.source_id;
      }
      
      return enriched;
    });

    return {
      alerts: enrichedAlerts,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    };
  } catch (error) {
    console.error("[alertService] 取得警報列表失敗:", error);
    throw error;
  }
}

/**
 * 創建警報
 * @param {Object} alertData - 警報資料
 * @returns {Promise<Object>} 創建的警報
 */
async function createAlert(alertData) {
  try {
    // 向後兼容：支持 device_id
    const {
      device_id,
      source = device_id ? ALERT_SOURCES.DEVICE : ALERT_SOURCES.DEVICE,
      source_id = device_id,
      source_type,
      alert_type,
      severity = SEVERITIES.WARNING,
      message,
      metadata = {},
    } = alertData;

    if (!source_id || !alert_type || !message) {
      throw new Error(
        "source_id（或 device_id）、alert_type 和 message 為必填欄位"
      );
    }

    // 驗證來源
    if (!Object.values(ALERT_SOURCES).includes(source)) {
      throw new Error(
        `無效的 source: ${source}。支援的來源: ${Object.values(
          ALERT_SOURCES
        ).join(", ")}`
      );
    }

    // 驗證警報類型
    if (!Object.values(ALERT_TYPES).includes(alert_type)) {
      throw new Error(
        `無效的 alert_type: ${alert_type}。支援的類型: ${Object.values(
          ALERT_TYPES
        ).join(", ")}`
      );
    }

    // 驗證嚴重程度
    if (!Object.values(SEVERITIES).includes(severity)) {
      throw new Error(
        `無效的 severity: ${severity}。支援的級別: ${Object.values(
          SEVERITIES
        ).join(", ")}`
      );
    }

    // 檢查是否已有未解決且未忽視的相同警報（避免重複創建）
    const existingAlert = await db.query(
      `SELECT id, created_at, severity 
			FROM alerts 
			WHERE source = ? 
				AND source_id = ? 
				AND alert_type = ? 
				AND status = ?
			ORDER BY created_at DESC 
			LIMIT 1`,
      [source, source_id, alert_type, ALERT_STATUS.ACTIVE]
    );

    if (existingAlert && existingAlert.length > 0) {
      // 如果已有相同警報，更新嚴重程度（取較高者）並返回現有警報
      const existing = existingAlert[0];
      const severityOrder = { warning: 1, error: 2, critical: 3 };
      const currentSeverity = severityOrder[existing.severity] || 0;
      const newSeverity = severityOrder[severity] || 0;

      if (newSeverity > currentSeverity) {
        // 更新為較高的嚴重程度
        await db.query(
          `UPDATE alerts 
					SET severity = ?, updated_at = CURRENT_TIMESTAMP
					WHERE id = ?`,
          [severity, existing.id]
        );
        console.log(
          `[alertService] 更新現有警報 ${existing.id} 的嚴重程度為 ${severity}`
        );
      }

      // 返回現有警報
      const updated = await db.query("SELECT * FROM alerts WHERE id = ?", [
        existing.id,
      ]);
      const alert = updated[0];
      
      // 向後兼容：添加 resolved 和 ignored 布爾值字段
      alert.resolved = alert.status === ALERT_STATUS.RESOLVED;
      alert.ignored = alert.status === ALERT_STATUS.IGNORED;
      
      // 向後兼容：如果是設備來源，添加 device_id 字段
      if (alert.source === ALERT_SOURCES.DEVICE) {
        alert.device_id = alert.source_id;
      }
      
      return alert;
    }

    // 創建新警報（默認為 active 狀態）
    const query = `
			INSERT INTO alerts (source, source_id, source_type, alert_type, severity, message, status, metadata)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING *
		`;
    const result = await db.query(query, [
      source,
      source_id,
      source_type || null,
      alert_type,
      severity,
      message,
      ALERT_STATUS.ACTIVE,
      JSON.stringify(metadata),
    ]);

    const alert = result[0];
    
    // 向後兼容：添加 resolved 和 ignored 布爾值字段
    alert.resolved = alert.status === ALERT_STATUS.RESOLVED;
    alert.ignored = alert.status === ALERT_STATUS.IGNORED;
    
    // 向後兼容：如果是設備來源，添加 device_id 字段
    if (alert.source === ALERT_SOURCES.DEVICE) {
      alert.device_id = alert.source_id;
    }
    
    return alert;
  } catch (error) {
    console.error("[alertService] 創建警報失敗:", error);
    throw error;
  }
}

/**
 * 取得單一警報
 * @param {number} id - 警報 ID
 * @returns {Promise<Object>} 警報資料
 */
async function getAlertById(id) {
  try {
    const query = `
			SELECT 
				a.*,
				ru.username as resolved_by_username,
				iu.username as ignored_by_username
			FROM alerts a
			LEFT JOIN users ru ON a.resolved_by = ru.id
			LEFT JOIN users iu ON a.ignored_by = iu.id
			WHERE a.id = ?
		`;
    const result = await db.query(query, [id]);

    if (!result || result.length === 0) {
      throw new Error(`警報 ID ${id} 不存在`);
    }

    const alert = result[0];
    
    // 向後兼容：添加 resolved 和 ignored 布爾值字段
    alert.resolved = alert.status === ALERT_STATUS.RESOLVED;
    alert.ignored = alert.status === ALERT_STATUS.IGNORED;
    
    // 向後兼容：如果是設備來源，添加 device_id 字段
    if (alert.source === ALERT_SOURCES.DEVICE) {
      alert.device_id = alert.source_id;
    }
    
    return alert;
  } catch (error) {
    console.error(`[alertService] 取得警報 ${id} 失敗:`, error);
    throw error;
  }
}

/**
 * 標記警報為未解決（管理員功能）
 * @param {number} id - 警報 ID
 * @returns {Promise<Object>} 更新後的警報
 */
async function unresolveAlert(id) {
  try {
    const query = `
			UPDATE alerts
			SET status = ?,
					resolved_at = NULL,
					resolved_by = NULL,
					updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
			RETURNING *
		`;
    const result = await db.query(query, [ALERT_STATUS.ACTIVE, id]);

    if (!result || result.length === 0) {
      throw new Error(`警報 ID ${id} 不存在`);
    }

    const alert = result[0];
    
    // 向後兼容：添加 resolved 和 ignored 布爾值字段
    alert.resolved = alert.status === ALERT_STATUS.RESOLVED;
    alert.ignored = alert.status === ALERT_STATUS.IGNORED;
    
    // 向後兼容：如果是設備來源，添加 device_id 字段
    if (alert.source === ALERT_SOURCES.DEVICE) {
      alert.device_id = alert.source_id;
    }
    
    return alert;
  } catch (error) {
    console.error(`[alertService] 取消解決警報 ${id} 失敗:`, error);
    throw error;
  }
}

/**
 * 更新警報狀態
 * @param {number} sourceId - 來源 ID
 * @param {string} source - 來源類型
 * @param {string} alertType - 警報類型
 * @param {string} newStatus - 新狀態
 * @param {number} userId - 用戶 ID
 * @returns {Promise<number>} 更新的警報數量
 */
async function updateAlertStatus(
  sourceId,
  source,
  alertType,
  newStatus,
  userId
) {
  try {
    if (!Object.values(ALERT_STATUS).includes(newStatus)) {
      throw new Error(`無效的狀態: ${newStatus}`);
    }

    const updateFields = [];
    const params = [];

    if (newStatus === ALERT_STATUS.RESOLVED) {
      updateFields.push("resolved_at = CURRENT_TIMESTAMP", "resolved_by = ?");
      params.push(userId);
    } else if (newStatus === ALERT_STATUS.IGNORED) {
      updateFields.push("ignored_at = CURRENT_TIMESTAMP", "ignored_by = ?");
      params.push(userId);
    } else if (newStatus === ALERT_STATUS.ACTIVE) {
      // 重新激活時清除解決和忽視資訊
      updateFields.push(
        "resolved_at = NULL",
        "resolved_by = NULL",
        "ignored_at = NULL",
        "ignored_by = NULL"
      );
    }

    updateFields.push("status = ?", "updated_at = CURRENT_TIMESTAMP");
    params.push(newStatus, sourceId, source, alertType);

    const query = `
			UPDATE alerts
			SET ${updateFields.join(", ")}
			WHERE source_id = ?
				AND source = ?
				AND alert_type = ?
				AND status != ?
			RETURNING id
		`;
    params.push(newStatus); // 避免重複更新

    const result = await db.query(query, params);

    if (!result || result.length === 0) {
      throw new Error(
        `未找到可更新的警報（來源: ${source}, ID: ${sourceId}, 類型: ${alertType}）`
      );
    }

    return result.length;
  } catch (error) {
    console.error(`[alertService] 更新警報狀態失敗:`, error);
    throw error;
  }
}

/**
 * 標記警示為已解決（支持多系統來源）
 * @param {number} sourceId - 來源 ID（設備 ID、位置 ID 等）
 * @param {string} alertType - 警報類型
 * @param {number} resolvedBy - 解決者用戶 ID
 * @param {string} source - 系統來源（可選，默認為 device）
 * @returns {Promise<number>} 更新的警示數量
 */
async function resolveAlert(sourceId, alertType, resolvedBy, source = ALERT_SOURCES.DEVICE) {
  return await updateAlertStatus(
    sourceId,
    source,
    alertType,
    ALERT_STATUS.RESOLVED,
    resolvedBy
  );
}

/**
 * 忽視警示（支持多系統來源）
 * @param {number} sourceId - 來源 ID（設備 ID、位置 ID 等）
 * @param {string} alertType - 警報類型
 * @param {number} ignoredBy - 忽視者用戶 ID
 * @param {string} source - 系統來源（可選，默認為 device）
 * @returns {Promise<number>} 忽視的警示數量
 */
async function ignoreAlerts(sourceId, alertType, ignoredBy, source = ALERT_SOURCES.DEVICE) {
  return await updateAlertStatus(
    sourceId,
    source,
    alertType,
    ALERT_STATUS.IGNORED,
    ignoredBy
  );
}

/**
 * 檢查來源是否已被忽視
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @returns {Promise<boolean>} 是否已被忽視
 */
async function isSourceIgnored(source, sourceId, alertType) {
  try {
    const result = await db.query(
      `SELECT id FROM alerts 
			WHERE source = ? 
				AND source_id = ? 
				AND alert_type = ? 
				AND status = ?
			LIMIT 1`,
      [source, sourceId, alertType, ALERT_STATUS.IGNORED]
    );

    return result && result.length > 0;
  } catch (error) {
    console.error(`[alertService] 檢查忽視狀態失敗:`, error);
    return false;
  }
}

/**
 * 取得未解決的警報數量
 * @param {Object} filters - 可選的篩選條件
 * @returns {Promise<number>} 未解決的警報數量
 */
async function getUnresolvedAlertCount(filters = {}) {
  try {
    const { source, source_id, device_id, alert_type, severity } = filters;

    // 向後兼容
    const actualSource =
      source || (device_id ? ALERT_SOURCES.DEVICE : undefined);
    const actualSourceId = source_id || device_id;

    let query = `
			SELECT COUNT(DISTINCT CONCAT(source::text, '-', source_id::text, '-', alert_type::text)) as count
			FROM alerts
			WHERE status = ?
		`;
    const params = [ALERT_STATUS.ACTIVE];

    if (actualSource) {
      query += " AND source = ?";
      params.push(actualSource);
    }
    if (actualSourceId) {
      query += " AND source_id = ?";
      params.push(actualSourceId);
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
    console.error("[alertService] 取得未解決警報數量失敗:", error);
    throw error;
  }
}

module.exports = {
  getAlerts,
  getAlertById,
  createAlert,
  updateAlertStatus,
  resolveAlert,
  ignoreAlerts,
  unresolveAlert,
  isSourceIgnored,
  getUnresolvedAlertCount,
  ALERT_SOURCES,
  ALERT_STATUS,
  ALERT_TYPES,
  SEVERITIES,
};
