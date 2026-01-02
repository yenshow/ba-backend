const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");

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

// 警報狀態（移除 pending，只保留 active, resolved, ignored
const ALERT_STATUS = {
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

// 移除 parseMetadata 函數（不再需要 metadata）

/**
 * 為警報添加向後兼容字段（提取為輔助函數，避免重複代碼）
 * @param {Object} alert - 警報對象
 * @returns {Object} 添加了向後兼容字段的警報對象
 */
function enrichAlert(alert) {
  const enriched = { ...alert };

  // 向後兼容：添加 resolved 和 ignored 布爾值字段
  enriched.resolved = alert.status === ALERT_STATUS.RESOLVED;
  enriched.ignored = alert.status === ALERT_STATUS.IGNORED;

  // 向後兼容：如果是設備來源，添加 device_id 字段
  if (alert.source === ALERT_SOURCES.DEVICE) {
    enriched.device_id = alert.source_id;
  }

  return enriched;
}

// 移除未使用的函數：deduplicateAlerts 和 sortAlerts
// 原因：移除了環境/照明系統與設備警報的關聯邏輯後，這些函數不再需要

/**
 * 生成警報查詢的 SELECT 語句（共用函數）
 * @returns {string} SELECT 語句
 */
function buildAlertSelectQuery() {
  return `
    SELECT 
      MIN(a.id) as id,
      a.source,
      a.source_id,
      a.alert_type,
      a.status,
      MAX(a.severity) as severity,
      MAX(a.message) as message,
      MAX(a.resolved_at) as resolved_at,
      MAX(a.resolved_by) as resolved_by,
      MAX(a.ignored_at) as ignored_at,
      MAX(a.ignored_by) as ignored_by,
      MIN(a.created_at) as created_at,
      MAX(a.updated_at) as latest_created_at,
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
    LEFT JOIN device_types dt ON d.type_id = dt.id`;
}

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
      alert_type,
      severity,
      status,
      resolved, // 向後兼容
      ignored, // 向後兼容
      start_date,
      end_date,
      updated_after, // 增量查詢：只獲取更新時間在此之後的警報
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
    let query = buildAlertSelectQuery() + ` WHERE 1=1`;
    const params = [];
    const countParams = []; // 單獨構建計數查詢的參數列表（不包含 updated_after、limit、offset）

    // 應用篩選條件
    if (actualSource) {
      query += " AND a.source = ?";
      params.push(actualSource);
      countParams.push(actualSource);
    }
    if (actualSourceId) {
      query += " AND a.source_id = ?";
      params.push(actualSourceId);
      countParams.push(actualSourceId);
    }
    if (alert_type) {
      query += " AND a.alert_type = ?";
      params.push(alert_type);
      countParams.push(alert_type);
    }
    if (severity) {
      query += " AND a.severity = ?";
      params.push(severity);
      countParams.push(severity);
    }
    if (actualStatus) {
      query += " AND a.status = ?";
      params.push(actualStatus);
      countParams.push(actualStatus);
    }
    if (start_date) {
      query += " AND a.created_at >= ?";
      params.push(start_date);
      countParams.push(start_date);
    }
    if (end_date) {
      query += " AND a.created_at <= ?";
      params.push(end_date);
      countParams.push(end_date);
    }
    // 增量查詢：只獲取更新時間在此之後的警報（優化輪詢效率）
    // 注意：countQuery 不包含 updated_after 條件，因為計數應該包含所有符合條件的記錄
    if (updated_after) {
      query += " AND a.updated_at >= ?";
      params.push(updated_after);
      // countParams 不添加 updated_after，因為計數查詢不需要這個條件
    }

    // 按來源、來源ID、警報類型、狀態分組
    query += ` GROUP BY a.source, a.source_id, a.alert_type, a.status`;

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

    let alerts = await db.query(query, params);

    // 取得總數（使用單獨構建的 countParams，不包含 updated_after）
    let countQuery = `
			SELECT COUNT(DISTINCT (a.source::text || '-' || a.source_id::text || '-' || a.alert_type::text || '-' || a.status::text)) as total
			FROM alerts a
			WHERE 1=1
		`;
    // countQuery 的條件已經在構建 countParams 時同步添加，這裡只需要構建查詢字符串
    if (actualSource) countQuery += " AND a.source = ?";
    if (actualSourceId) countQuery += " AND a.source_id = ?";
    if (alert_type) countQuery += " AND a.alert_type = ?";
    if (severity) countQuery += " AND a.severity = ?";
    if (actualStatus) countQuery += " AND a.status = ?";
    if (start_date) countQuery += " AND a.created_at >= ?";
    if (end_date) countQuery += " AND a.created_at <= ?";
    // 注意：countQuery 不包含 updated_after 條件，因為計數應該包含所有符合條件的記錄

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult[0]?.total || 0);

    // 注意：由於移除了 metadata，環境/照明系統與設備警報的關聯功能已簡化
    // 如果需要關聯設備警報到系統，需要重新設計（例如通過設備 ID 直接關聯）

    // 為每個 alert 添加向後兼容的字段
    const enrichedAlerts = (alerts || []).map(enrichAlert);

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
      alert_type,
      severity = SEVERITIES.WARNING,
      message,
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

    // 優化：先檢查是否有被忽視的警報（優先級最高，使用索引優化查詢）
    const ignoredAlert = await db.query(
      `SELECT id FROM alerts 
			WHERE source = ? 
				AND source_id = ? 
				AND alert_type = ? 
				AND status = ?
			LIMIT 1`,
      [source, source_id, alert_type, ALERT_STATUS.IGNORED]
    );

    if (ignoredAlert && ignoredAlert.length > 0) {
      // 如果警報已被忽視，不創建新警報（忽視功能：不再顯示相同來源和類型的警示）
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[alertService] 警報已被忽視，不創建新警報: source=${source}, source_id=${source_id}, alert_type=${alert_type}`
        );
      }
      // 返回忽視的警報（不更新，保持忽視狀態）
      const existing = await db.query("SELECT * FROM alerts WHERE id = ?", [
        ignoredAlert[0].id,
      ]);
      return enrichAlert(existing[0]);
    }

    // 使用事務和 SELECT FOR UPDATE 防止並發問題
    // 先嘗試更新現有的 active 警報
    // 注意：PostgreSQL 無法直接比較數字和 ENUM，需要使用 CASE WHEN 轉換
    const severityOrder = { warning: 1, error: 2, critical: 3 };
    const newSeverityOrder = severityOrder[severity] || 0;

    // 使用原子更新操作（使用 RETURNING 獲取更新結果）
    // 注意：updated_at 會通過觸發器自動更新，不需要手動設置
    // 使用 CASE WHEN 將 ENUM 轉換為數字後再比較
    const updateQuery = `
			UPDATE alerts 
			SET severity = CASE 
					WHEN (CASE severity 
						WHEN 'warning' THEN 1 
						WHEN 'error' THEN 2 
						WHEN 'critical' THEN 3 
						ELSE 0 
					END) < ? 
					THEN ?::alert_severity 
					ELSE severity 
				END,
				message = CASE 
					WHEN (CASE severity 
						WHEN 'warning' THEN 1 
						WHEN 'error' THEN 2 
						WHEN 'critical' THEN 3 
						ELSE 0 
					END) < ? 
					THEN ? 
					ELSE alerts.message 
				END
			WHERE source = ? 
				AND source_id = ? 
				AND alert_type = ? 
				AND status = ?
			RETURNING *
		`;

    const updateResult = await db.query(updateQuery, [
      newSeverityOrder,
      severity,
      newSeverityOrder,
      message,
      source,
      source_id,
      alert_type,
      ALERT_STATUS.ACTIVE,
    ]);

    if (updateResult && updateResult.length > 0) {
      // 成功更新現有警報
      const alert = updateResult[0];

      if (process.env.NODE_ENV === "development") {
        console.log(
          `[alertService] 更新現有警報 ${alert.id}: 嚴重程度=${alert.severity}`
        );
      }

      const enrichedAlert = enrichAlert(alert);

      // 推送 WebSocket 事件：警報更新（嚴重程度變化）
      // 注意：這裡是更新現有警報，狀態仍然是 active
      websocketService.emitAlertUpdated(
        enrichedAlert,
        ALERT_STATUS.ACTIVE,
        ALERT_STATUS.ACTIVE
      );

      return enrichedAlert;
    }

    // 沒有現有警報，創建新警報
    // 使用 INSERT 語句，如果發生並發衝突，會由唯一索引捕獲
    const insertQuery = `
			INSERT INTO alerts (source, source_id, alert_type, severity, message, status)
			VALUES (?, ?, ?, ?, ?, ?)
			RETURNING *
		`;

    try {
      const insertResult = await db.query(insertQuery, [
        source,
        source_id,
        alert_type,
        severity,
        message,
        ALERT_STATUS.ACTIVE,
      ]);

      const alert = insertResult[0];

      if (process.env.NODE_ENV === "development") {
        console.log(
          `[alertService] 創建新警報 ${alert.id}: 嚴重程度=${alert.severity}`
        );
      }

      const enrichedAlert = enrichAlert(alert);

      // 推送 WebSocket 事件：新警報創建
      websocketService.emitAlertNew(enrichedAlert);

      return enrichedAlert;
    } catch (error) {
      // 如果唯一約束衝突（並發創建情況），再次嘗試更新
      if (
        error.code === "23505" ||
        error.message.includes("unique_active_alert")
      ) {
        // 等待一小段時間，確保另一個事務已完成
        await new Promise((resolve) => setTimeout(resolve, 10));

        const retryResult = await db.query(updateQuery, [
          newSeverityOrder,
          severity,
          message,
          source,
          source_id,
          alert_type,
          ALERT_STATUS.ACTIVE,
        ]);

        if (retryResult && retryResult.length > 0) {
          if (process.env.NODE_ENV === "development") {
            console.log(
              `[alertService] 並發衝突後更新警報 ${retryResult[0].id}`
            );
          }
          const enrichedAlert = enrichAlert(retryResult[0]);

          // 推送 WebSocket 事件：警報更新（從無到有）
          websocketService.emitAlertUpdated(
            enrichedAlert,
            null,
            ALERT_STATUS.ACTIVE
          );

          return enrichedAlert;
        }
      }
      throw error;
    }
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
    return enrichAlert(alert);
  } catch (error) {
    console.error(`[alertService] 取得警報 ${id} 失敗:`, error);
    throw error;
  }
}

/**
 * 標記警報為未解決（管理員功能）
 * @param {number} id - 警報 ID
 * @param {number|null} userId - 用戶 ID（可選）
 * @returns {Promise<Object>} 更新後的警報
 */
async function unresolveAlert(id, userId = null) {
  try {
    // 先查詢當前狀態
    const currentAlert = await db.query(
      `SELECT id, status FROM alerts WHERE id = ?`,
      [id]
    );

    if (!currentAlert || currentAlert.length === 0) {
      throw new Error(`警報 ID ${id} 不存在`);
    }

    const oldStatus = currentAlert[0].status;

    // 更新警報狀態
    const query = `
			UPDATE alerts
			SET status = ?,
					resolved_at = NULL,
					resolved_by = NULL,
					ignored_at = NULL,
					ignored_by = NULL
			WHERE id = ?
			RETURNING *
		`;
    const result = await db.query(query, [ALERT_STATUS.ACTIVE, id]);

    if (!result || result.length === 0) {
      throw new Error(`警報 ID ${id} 不存在`);
    }

    const alert = result[0];

    // 記錄狀態變更歷史
    if (oldStatus !== ALERT_STATUS.ACTIVE) {
      await db.query(
        `INSERT INTO alert_history (alert_id, old_status, new_status, changed_by)
			VALUES (?, ?, ?, ?)`,
        [id, oldStatus, ALERT_STATUS.ACTIVE, userId]
      );
    }

    const enrichedAlert = enrichAlert(alert);

    // 推送 WebSocket 事件：警報狀態更新（unresolve）
    if (oldStatus !== ALERT_STATUS.ACTIVE) {
      websocketService.emitAlertUpdated(
        enrichedAlert,
        oldStatus,
        ALERT_STATUS.ACTIVE
      );
    }

    return enrichedAlert;
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
 * @param {string|null} reason - 變更原因（可選）
 * @returns {Promise<number>} 更新的警報數量
 */
async function updateAlertStatus(
  sourceId,
  source,
  alertType,
  newStatus,
  userId,
  reason = null
) {
  try {
    if (!Object.values(ALERT_STATUS).includes(newStatus)) {
      throw new Error(`無效的狀態: ${newStatus}`);
    }

    // 先查詢當前狀態和警報 ID
    const currentAlert = await db.query(
      `SELECT id, status FROM alerts 
			WHERE source_id = ? AND source = ? AND alert_type = ? 
			AND status != ? 
			LIMIT 1`,
      [sourceId, source, alertType, newStatus]
    );

    if (!currentAlert || currentAlert.length === 0) {
      throw new Error(
        `未找到可更新的警報（來源: ${source}, ID: ${sourceId}, 類型: ${alertType}）`
      );
    }

    const oldStatus = currentAlert[0].status;
    const alertId = currentAlert[0].id;

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

    // updated_at 會通過觸發器自動更新
    updateFields.push("status = ?");
    // SET 部分的參數：status = ? 的值
    params.push(newStatus);
    // WHERE 條件的參數（順序要與 WHERE 子句中的條件順序一致）
    params.push(sourceId, source, alertType, newStatus);

    const query = `
			UPDATE alerts
			SET ${updateFields.join(", ")}
			WHERE source_id = ?
				AND source = ?
				AND alert_type = ?
				AND status != ?
			RETURNING id
		`;

    const result = await db.query(query, params);

    if (!result || result.length === 0) {
      throw new Error(
        `未找到可更新的警報（來源: ${source}, ID: ${sourceId}, 類型: ${alertType}）`
      );
    }

    // 記錄狀態變更歷史（只有在狀態真正改變時才記錄）
    if (oldStatus !== newStatus) {
      await db.query(
        `INSERT INTO alert_history (alert_id, old_status, new_status, changed_by, reason)
			VALUES (?, ?, ?, ?, ?)`,
        [alertId, oldStatus, newStatus, userId, reason]
      );

      // 推送 WebSocket 事件：警報狀態更新
      // 查詢更新後的警報資料
      const updatedAlert = await getAlertById(alertId);
      if (updatedAlert) {
        websocketService.emitAlertUpdated(updatedAlert, oldStatus, newStatus);
      }
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
async function resolveAlert(
  sourceId,
  alertType,
  resolvedBy,
  source = ALERT_SOURCES.DEVICE
) {
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
async function ignoreAlerts(
  sourceId,
  alertType,
  ignoredBy,
  source = ALERT_SOURCES.DEVICE
) {
  return await updateAlertStatus(
    sourceId,
    source,
    alertType,
    ALERT_STATUS.IGNORED,
    ignoredBy
  );
}

/**
 * 取消忽視警示（支持多系統來源）
 * @param {number} sourceId - 來源 ID（設備 ID、位置 ID 等）
 * @param {string} alertType - 警報類型
 * @param {string} source - 系統來源（可選，默認為 device）
 * @returns {Promise<number>} 取消忽視的警示數量
 */
async function unignoreAlerts(
  sourceId,
  alertType,
  source = ALERT_SOURCES.DEVICE
) {
  return await updateAlertStatus(
    sourceId,
    source,
    alertType,
    ALERT_STATUS.ACTIVE,
    null // 不需要用戶 ID，因為是取消忽視
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
			SELECT COUNT(DISTINCT (source::text || '-' || source_id::text || '-' || alert_type::text)) as count
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

/**
 * 取得警報歷史記錄
 * @param {number} alertId - 警報 ID
 * @returns {Promise<Array>} 歷史記錄列表
 */
async function getAlertHistory(alertId) {
  try {
    const query = `
			SELECT 
				ah.*,
				u.username as changed_by_username
			FROM alert_history ah
			LEFT JOIN users u ON ah.changed_by = u.id
			WHERE ah.alert_id = ?
			ORDER BY ah.changed_at DESC
		`;
    const result = await db.query(query, [alertId]);
    return result || [];
  } catch (error) {
    console.error(`[alertService] 取得警報歷史記錄失敗:`, error);
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
  unignoreAlerts,
  unresolveAlert,
  isSourceIgnored,
  getUnresolvedAlertCount,
  getAlertHistory,
  ALERT_SOURCES,
  ALERT_STATUS,
  ALERT_TYPES,
  SEVERITIES,
};
