const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");

/**
 * 統一警報服務
 * 支持多系統來源：device, environment, lighting 等
 */

/**
 * 參數匹配正則表達式（用於從警報訊息中提取參數名稱）
 */
const PARAMETER_PATTERN =
  /\b(PM2\.5|PM10|CO2|溫度|濕度|噪音值|TVOC|HCHO|風速)\b/;

/**
 * 從警報訊息中提取參數名稱（用於閾值警報的參數匹配）
 * @param {string} message - 警報訊息
 * @returns {string|null} 參數名稱，如果未找到則返回 null
 */
function extractParameterFromMessage(message) {
  if (!message) return null;
  const match = message.match(PARAMETER_PATTERN);
  return match ? match[1] : null;
}

/**
 * 獲取當天的開始和結束時間（UTC）
 * 用於按天限制警報查詢，確保同一天只會有一個 active 警報
 * @returns {Object} { todayStart, todayEnd } - 當天的開始和結束時間（ISO 字符串）
 */
function getTodayDateRange() {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const todayEnd = new Date(todayStart);
  todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);
  
  return {
    todayStart: todayStart.toISOString(),
    todayEnd: todayEnd.toISOString()
  };
}

/**
 * 查詢被忽視的警報（支持參數匹配）
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string|null} parameter - 參數名稱（用於閾值警報匹配，可選）
 * @returns {Promise<Object|null>} 被忽視的警報，如果不存在則返回 null
 */
async function findIgnoredAlert(source, sourceId, alertType, parameter = null) {
  let ignoredAlert;

  // 對於閾值警報，如果提供了參數，使用參數匹配查詢
  if (alertType === ALERT_TYPES.THRESHOLD && parameter) {
    ignoredAlert = await db.query(
      `SELECT * FROM alerts 
      WHERE source = ? 
        AND source_id = ? 
        AND alert_type = ? 
        AND status = ?
        AND message LIKE ?
      LIMIT 1`,
      [
        source,
        sourceId,
        alertType,
        ALERT_STATUS.IGNORED,
        `%${parameter}%`,
      ]
    );
  }

  // 如果沒有通過參數匹配找到，或者不是 threshold 類型，使用標準查詢
  if (!ignoredAlert || ignoredAlert.length === 0) {
    ignoredAlert = await db.query(
      `SELECT * FROM alerts 
      WHERE source = ? 
        AND source_id = ? 
        AND alert_type = ? 
        AND status = ?
      LIMIT 1`,
      [source, sourceId, alertType, ALERT_STATUS.IGNORED]
    );
  }

  return ignoredAlert && ignoredAlert.length > 0 ? ignoredAlert[0] : null;
}

/**
 * 查詢現有的 active 警報（支持按天限制和參數匹配）
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string|null} parameter - 參數名稱（用於閾值警報匹配，可選）
 * @returns {Promise<Object|null>} 現有的 active 警報，如果不存在則返回 null
 */
async function findExistingActiveAlert(source, sourceId, alertType, parameter = null) {
  const { todayStart, todayEnd } = getTodayDateRange();
  let existingAlert;

  // 對於閾值警報，如果提供了參數，使用參數匹配查詢
  if (alertType === ALERT_TYPES.THRESHOLD && parameter) {
    existingAlert = await db.query(
      `SELECT * FROM alerts 
      WHERE source = ? 
        AND source_id = ? 
        AND alert_type = ? 
        AND status = ?
        AND message LIKE ?
        AND created_at >= ?
        AND created_at < ?
      LIMIT 1`,
      [
        source,
        sourceId,
        alertType,
        ALERT_STATUS.ACTIVE,
        `%${parameter}%`,
        todayStart,
        todayEnd,
      ]
    );
  }

  // 如果沒有通過參數匹配找到，或者不是 threshold 類型，使用標準查詢
  if (!existingAlert || existingAlert.length === 0) {
    existingAlert = await db.query(
      `SELECT * FROM alerts 
      WHERE source = ? 
        AND source_id = ? 
        AND alert_type = ? 
        AND status = ?
        AND created_at >= ?
        AND created_at < ?
      LIMIT 1`,
      [
        source,
        sourceId,
        alertType,
        ALERT_STATUS.ACTIVE,
        todayStart,
        todayEnd,
      ]
    );
  }

  return existingAlert && existingAlert.length > 0 ? existingAlert[0] : null;
}

/**
 * 判斷 severity 是否需要升級
 * @param {string} currentSeverity - 當前嚴重程度
 * @param {string} newSeverity - 新嚴重程度
 * @returns {boolean} 是否需要升級
 */
function shouldUpgradeSeverity(currentSeverity, newSeverity) {
  const severityOrder = { warning: 1, error: 2, critical: 3 };
  const currentOrder = severityOrder[currentSeverity] || 0;
  const newOrder = severityOrder[newSeverity] || 0;
  return newOrder > currentOrder;
}

/**
 * 更新警報的 severity 和 message
 * @param {number} alertId - 警報 ID
 * @param {string} severity - 新嚴重程度
 * @param {string} message - 新訊息
 * @returns {Promise<Object>} 更新後的警報
 */
async function updateAlertContent(alertId, severity, message) {
  const updateQuery = `
    UPDATE alerts 
    SET severity = ?::alert_severity,
        message = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    RETURNING *
  `;

  const result = await db.query(updateQuery, [severity, message, alertId]);
  return result && result.length > 0 ? result[0] : null;
}

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
      MAX(a.updated_at) as updated_at,
      COUNT(*) as alert_count,
      MAX(ru.username) as resolved_by_username,
      MAX(iu.username) as ignored_by_username,
      -- 設備類型資訊（適用於設備來源和環境/照明系統的關聯設備）
      MAX(CASE 
        WHEN a.source = 'device' THEN dt.name
        WHEN a.source = 'environment' THEN dt_env.name
        WHEN a.source = 'lighting' THEN dt_lighting.name
        ELSE NULL
      END) as device_type_name,
      MAX(CASE 
        WHEN a.source = 'device' THEN dt.code
        WHEN a.source = 'environment' THEN dt_env.code
        WHEN a.source = 'lighting' THEN dt_lighting.code
        ELSE NULL
      END) as device_type_code,
      -- 來源名稱（統一欄位，適用於所有來源類型）
      MAX(CASE 
        WHEN a.source = 'device' THEN d.name
        WHEN a.source = 'environment' THEN el.name
        WHEN a.source = 'lighting' THEN la.name
        ELSE NULL
      END) as source_name,
      -- 向後兼容：device_name（與 source_name 相同，當 source = 'device' 時）
      MAX(CASE WHEN a.source = 'device' THEN d.name END) as device_name,
      -- 樓層名稱（環境或照明系統）
      MAX(CASE WHEN a.source = 'environment' THEN ef.name END) as environment_floor_name,
      MAX(CASE WHEN a.source = 'lighting' THEN lf.name END) as lighting_floor_name
    FROM alerts a
    LEFT JOIN users ru ON a.resolved_by = ru.id
    LEFT JOIN users iu ON a.ignored_by = iu.id
    LEFT JOIN devices d ON a.source = 'device' AND a.source_id = d.id
    LEFT JOIN device_types dt ON d.type_id = dt.id
    LEFT JOIN environment_locations el ON a.source = 'environment' AND a.source_id = el.id
    LEFT JOIN devices d_env ON el.device_id = d_env.id
    LEFT JOIN device_types dt_env ON d_env.type_id = dt_env.id
    LEFT JOIN environment_floors ef ON el.floor_id = ef.id
    LEFT JOIN lighting_areas la ON a.source = 'lighting' AND a.source_id = la.id
    LEFT JOIN devices d_lighting ON la.device_id = d_lighting.id
    LEFT JOIN device_types dt_lighting ON d_lighting.type_id = dt_lighting.id
    LEFT JOIN lighting_floors lf ON la.floor_id = lf.id`;
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
      "updated_at",
      "severity",
      "alert_type",
      "status",
    ];
    const orderByField = validOrderBy.includes(orderBy)
      ? orderBy === "created_at"
        ? "MIN(a.created_at)"
        : orderBy === "updated_at"
        ? "MAX(a.updated_at)"
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
      source = ALERT_SOURCES.DEVICE, // 默認值，如果提供 device_id 則會被覆蓋
      source_id = device_id,
      alert_type,
      severity = SEVERITIES.WARNING,
      message,
    } = alertData;

    // 如果提供了 device_id，使用 device 作為 source
    const actualSource = device_id ? ALERT_SOURCES.DEVICE : source;

    if (!source_id || !alert_type) {
      throw new Error("source_id（或 device_id）和 alert_type 為必填欄位");
    }

    // message 必填（errorTracker 會總是提供）
    if (!message) {
      throw new Error("message 為必填欄位");
    }

    // 驗證來源
    if (!Object.values(ALERT_SOURCES).includes(actualSource)) {
      throw new Error(
        `無效的 source: ${actualSource}。支援的來源: ${Object.values(
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
    // 對於閾值警報（threshold），需要通過 message 匹配參數（因為同一個 source 可能有多個不同參數的警報）
    const parameter = extractParameterFromMessage(message);
    const ignoredAlert = await findIgnoredAlert(
          actualSource,
          source_id,
          alert_type,
      parameter
      );

    if (ignoredAlert) {
      // 如果警報已被忽視，不創建新警報（忽視功能：不再顯示相同來源和類型的警示）
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[alertService] 警報已被忽視，不創建新警報: source=${actualSource}, source_id=${source_id}, alert_type=${alert_type}`
        );
      }
      // 返回忽視的警報（不更新，保持忽視狀態）
      return enrichAlert(ignoredAlert);
    }

    // 先查詢現有的 active 警報，檢查 severity 是否需要更新
    // 優化：使用提取的輔助函數，減少重複代碼
    // 重要：添加按天限制，確保同一天只會有一個 active 警報（符合文檔說明）
    const existingAlert = await findExistingActiveAlert(
          actualSource,
          source_id,
          alert_type,
      parameter
    );

    if (existingAlert) {
      const currentSeverity = existingAlert.severity;
      const needsUpgrade = shouldUpgradeSeverity(currentSeverity, severity);
      const messageChanged = existingAlert.message !== message;

      if (needsUpgrade || messageChanged) {
        // severity 需要升級或 message 需要更新，更新警報
        const updatedAlert = await updateAlertContent(
          existingAlert.id,
          severity,
          message
        );

        if (updatedAlert) {
          if (needsUpgrade) {
            console.log(
              `[alertService] 🔄 警報已更新 | ID:${updatedAlert.id} | ${actualSource}:${source_id} | ` +
                `類型:${alert_type} | 嚴重程度:${currentSeverity} -> ${severity}`
            );
          } else {
            console.log(
              `[alertService] 🔄 警報數值已更新 | ID:${updatedAlert.id} | ${actualSource}:${source_id} | ` +
                `類型:${alert_type} | 新 message: ${message}`
            );
          }

          const enrichedAlert = enrichAlert(updatedAlert);

          // 推送 WebSocket 事件：警報更新（severity 升級或數值更新）
          websocketService.emitAlertUpdated(
            enrichedAlert,
            ALERT_STATUS.ACTIVE,
            ALERT_STATUS.ACTIVE
          );

          // 推送未解決警報數量
          emitUnresolvedAlertCount();

          return enrichedAlert;
        }
      } else {
        // severity 和 message 都不需要更新，直接返回現有警報
        console.log(
          `[alertService] 警報已存在且未改變 | ID:${existingAlert.id} | ` +
            `${actualSource}:${source_id} | 類型:${alert_type} | 嚴重程度:${currentSeverity}`
        );

        return enrichAlert(existingAlert);
      }
    }

    // 沒有現有 active 警報，需要創建新警報
    // message 已在函數開頭檢查，這裡不需要重複檢查

    // 使用 INSERT 語句，如果發生並發衝突，會由唯一索引捕獲
    if (process.env.NODE_ENV === "development") {
      console.log(
        `[alertService] ➕ 創建新警報 | ${actualSource}:${source_id} | ` +
          `類型:${alert_type} | 嚴重程度:${severity}`
      );
    }

    const insertQuery = `
			INSERT INTO alerts (source, source_id, alert_type, severity, message, status)
			VALUES (?, ?, ?, ?, ?, ?)
			RETURNING *
		`;

    try {
      const insertResult = await db.query(insertQuery, [
        actualSource,
        source_id,
        alert_type,
        severity,
        message,
        ALERT_STATUS.ACTIVE,
      ]);

      const alert = insertResult[0];

      // 記錄警報創建日誌（結構化日誌）
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[alertService] ✅ 新警報創建 | ID:${alert.id} | ${actualSource}:${source_id} | ` +
            `類型:${alert_type} | 嚴重程度:${severity}`
        );
      }

      const enrichedAlert = enrichAlert(alert);

      // 推送 WebSocket 事件：新警報創建（優先推送，確保即時性）
      websocketService.emitAlertNew(enrichedAlert);

      // 更新並推送未解決警報數量（非阻塞執行）
      emitUnresolvedAlertCount();

      return enrichedAlert;
    } catch (error) {
      // 如果唯一約束衝突（並發創建情況），再次嘗試查詢並更新
      if (
        error.code === "23505" ||
        error.message.includes("unique_active_alert")
      ) {
        // 等待一小段時間，確保另一個事務已完成
        await new Promise((resolve) => setTimeout(resolve, 10));

        // 重新查詢現有警報（使用相同的日期限制和參數匹配）
        const retryExistingAlert = await findExistingActiveAlert(
          actualSource,
          source_id,
          alert_type,
          parameter
        );

        if (retryExistingAlert) {
          const currentSeverity = retryExistingAlert.severity;
          const needsUpgrade = shouldUpgradeSeverity(currentSeverity, severity);
          const messageChanged = retryExistingAlert.message !== message;

          if (needsUpgrade || messageChanged) {
            // 更新警報
            const updatedAlert = await updateAlertContent(
              retryExistingAlert.id,
              severity,
              message
            );

            if (updatedAlert) {
          if (process.env.NODE_ENV === "development") {
            console.log(
                  `[alertService] 並發衝突後更新警報 ${updatedAlert.id}`
            );
          }
              const enrichedAlert = enrichAlert(updatedAlert);

              // 推送 WebSocket 事件：警報更新
          websocketService.emitAlertUpdated(
            enrichedAlert,
                ALERT_STATUS.ACTIVE,
            ALERT_STATUS.ACTIVE
          );

          // 更新並推送未解決警報數量（非阻塞執行）
          emitUnresolvedAlertCount();

          return enrichedAlert;
            }
          } else {
            // 不需要更新，直接返回現有警報
            return enrichAlert(retryExistingAlert);
          }
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

      // 更新並推送未解決警報數量
      emitUnresolvedAlertCount();
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

    // 先查詢當前狀態和警報 ID（用於判斷狀態是否改變和記錄歷史）
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

    // 觸發器會自動更新 updated_at，但為了確保觸發，我們明確設置
    updateFields.push("status = ?", "updated_at = CURRENT_TIMESTAMP");
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
      const alertQuery = `
        SELECT 
          a.*,
          ru.username as resolved_by_username,
          iu.username as ignored_by_username
        FROM alerts a
        LEFT JOIN users ru ON a.resolved_by = ru.id
        LEFT JOIN users iu ON a.ignored_by = iu.id
        WHERE a.id = ?
      `;
      const alertResult = await db.query(alertQuery, [alertId]);
      if (alertResult && alertResult.length > 0) {
        const updatedAlert = enrichAlert(alertResult[0]);
        websocketService.emitAlertUpdated(updatedAlert, oldStatus, newStatus);

        // 更新並推送未解決警報數量（僅在狀態真正改變時）
        void emitUnresolvedAlertCount();
      }
    }

    return result.length;
  } catch (error) {
    // 如果錯誤是"未找到可更新的警報"，這是正常情況（警報可能不存在或已經被解決）
    // 不記錄為錯誤，直接拋出讓調用者處理
    if (error.message && error.message.includes("未找到可更新的警報")) {
      throw error; // 直接拋出，不記錄
    }
    // 其他錯誤才記錄
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
  // 更新警報狀態為 ACTIVE
  const result = await updateAlertStatus(
    sourceId,
    source,
    alertType,
    ALERT_STATUS.ACTIVE,
    null // 不需要用戶 ID，因為是取消忽視
  );

  // 確保 error_tracking 中的 alert_created 標記正確設置，並檢查是否需要立即解決警報
  // 使用延遲 require 避免循環依賴
  try {
    const errorTracker = require("./errorTracker");

    // 更新 alert_created 標記（如果為 FALSE）
    await db.query(
      `UPDATE error_tracking 
      SET alert_created = TRUE, updated_at = CURRENT_TIMESTAMP
      WHERE source = ? AND source_id = ? AND alert_created = FALSE`,
      [source, sourceId]
    );

    // 檢查設備是否已經恢復正常（error_count = 0）
    // 如果已恢復，立即調用 clearError 自動解決警報（統一使用 clearError 邏輯）
    const tracking = await errorTracker.getErrorTracking(source, sourceId);
    if (tracking && tracking.error_count === 0) {
      await errorTracker.clearError(source, sourceId, alertType);
    }
  } catch (error) {
    // 如果更新 error_tracking 失敗，不影響取消忽視操作（警報已成功恢復為 ACTIVE）
    if (process.env.NODE_ENV === "development") {
      console.warn(
        `[alertService] 更新 error_tracking 失敗（不影響取消忽視）:`,
        error.message
      );
    }
  }

  return result;
}

/**
 * 檢查來源是否已被忽視
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string|null} message - 警報訊息（可選，用於閾值警報的參數匹配）
 * @returns {Promise<boolean>} 是否已被忽視
 */
async function isSourceIgnored(source, sourceId, alertType, message = null) {
  try {
    // 對於閾值警報，如果提供了 message，嘗試參數匹配
    const parameter = extractParameterFromMessage(message);

    if (alertType === ALERT_TYPES.THRESHOLD && parameter) {
      const result = await db.query(
        `SELECT id FROM alerts 
        WHERE source = ? 
          AND source_id = ? 
          AND alert_type = ? 
          AND status = ?
          AND message LIKE ?
        LIMIT 1`,
        [source, sourceId, alertType, ALERT_STATUS.IGNORED, `%${parameter}%`]
      );
      if (result && result.length > 0) {
        return true;
      }
    }

    // 標準查詢（非閾值警報或參數匹配失敗時使用）
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

// 防抖計時器，避免頻繁推送未解決警報數量（優化：減少資料庫查詢和 WebSocket 推送）
let unresolvedCountTimer = null;
const UNRESOLVED_COUNT_DEBOUNCE_MS = 500; // 500ms 防抖

/**
 * 推送未解決警報數量（內部輔助函數）
 * 獲取未解決警報數量並透過 WebSocket 推送
 * 優化：使用防抖機制，避免在短時間內多次調用
 */
function emitUnresolvedAlertCount() {
  // 清除之前的計時器
  if (unresolvedCountTimer) {
    clearTimeout(unresolvedCountTimer);
  }

  // 設置新的計時器（防抖）
  unresolvedCountTimer = setTimeout(async () => {
    try {
      const count = await getUnresolvedAlertCount();
      websocketService.emitAlertCount(count);
      if (process.env.NODE_ENV === "development") {
        console.log(`[alertService] 📢 已推送未解決警報數量: ${count}`);
      }
    } catch (error) {
      console.error("[alertService] ❌ 推送未解決警報數量失敗:", error.message);
      // 不拋出錯誤，避免影響主要流程
    } finally {
      unresolvedCountTimer = null;
    }
  }, UNRESOLVED_COUNT_DEBOUNCE_MS);
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
