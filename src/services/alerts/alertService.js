const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");

/**
 * 統一警報服務
 * 支持多系統來源：device, environment, lighting 等
 */

/**
 * 統一日誌函數（減少重複的環境檢查）
 * @param {string} level - 日誌級別 ('log', 'warn', 'error')
 * @param {string} message - 日誌訊息
 */
function log(level, message) {
  if (process.env.NODE_ENV === "development") {
    console[level](message);
  }
}

/**
 * 開發模式日誌（簡化寫法）
 */
const devLog = {
  log: (msg) => log("log", msg),
  warn: (msg) => log("warn", msg),
  error: (msg) => log("error", msg),
};

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
  const todayStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
  const todayEnd = new Date(todayStart);
  todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);

  return {
    todayStart: todayStart.toISOString(),
    todayEnd: todayEnd.toISOString(),
  };
}

/**
 * 構建警報查詢的通用邏輯（提取重複代碼）
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string} status - 警報狀態
 * @param {string|null} parameter - 參數名稱（用於閾值警報匹配，可選）
 * @param {Object|null} dateRange - 日期範圍 { start, end }，可選
 * @param {string} orderBy - 排序方式，默認為 "created_at DESC"
 * @param {number|null} limit - 限制數量，可選
 * @returns {Promise<Array>} 查詢結果
 */
async function queryAlerts(
  source,
  sourceId,
  alertType,
  status,
  parameter = null,
  dateRange = null,
  orderBy = "created_at DESC",
  limit = null
) {
  let query = `SELECT * FROM alerts WHERE source = ? AND source_id = ? AND alert_type = ? AND status = ?`;
  const params = [source, sourceId, alertType, status];

  // 添加參數匹配條件（閾值警報且提供了參數）
  if (alertType === ALERT_TYPES.THRESHOLD && parameter) {
    query += " AND message LIKE ?";
    params.push(`%${parameter}%`);
  }

  // 添加日期範圍條件
  if (dateRange) {
    if (dateRange.start) {
      query += " AND created_at >= ?";
      params.push(dateRange.start);
    }
    if (dateRange.end) {
      query += " AND created_at < ?";
      params.push(dateRange.end);
    }
  }

  // 添加排序
  if (orderBy) {
    query += ` ORDER BY ${orderBy}`;
  }

  // 添加限制
  if (limit) {
    query += " LIMIT ?";
    params.push(limit);
  }

  const result = await db.query(query, params);
  return result || [];
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
  const alerts = await queryAlerts(
    source,
    sourceId,
    alertType,
    ALERT_STATUS.IGNORED,
    parameter,
    null, // 不限日期
    null, // 不需要排序
    1 // 只取第一個
  );
  return alerts.length > 0 ? alerts[0] : null;
}

/**
 * 查詢現有的 active 警報（支持按天限制和參數匹配）
 * 用於創建/更新警報時，確保同一天只有一個 active 警報
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string|null} parameter - 參數名稱（用於閾值警報匹配，可選）
 * @returns {Promise<Object|null>} 現有的 active 警報，如果不存在則返回 null
 */
async function findExistingActiveAlert(
  source,
  sourceId,
  alertType,
  parameter = null
) {
  const { todayStart, todayEnd } = getTodayDateRange();
  const alerts = await queryAlerts(
    source,
    sourceId,
    alertType,
    ALERT_STATUS.ACTIVE,
    parameter,
    { start: todayStart, end: todayEnd }, // 按天限制
    null, // 不需要排序
    1 // 只取第一個
  );
  return alerts.length > 0 ? alerts[0] : null;
}

/**
 * 查詢所有現有的 active 警報（不限制日期，用於自動解決跨天警報）
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string|null} parameter - 參數名稱（用於閾值警報匹配，可選）
 * @returns {Promise<Array>} 所有現有的 active 警報列表
 */
async function findAllActiveAlerts(
  source,
  sourceId,
  alertType,
  parameter = null
) {
  return await queryAlerts(
    source,
    sourceId,
    alertType,
    ALERT_STATUS.ACTIVE,
    parameter,
    null, // 不限日期
    "created_at DESC" // 按創建時間倒序
  );
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
 * 處理警報更新邏輯（提取重複代碼）
 * @param {Object} existingAlert - 現有警報
 * @param {string} severity - 新嚴重程度
 * @param {string} message - 新訊息
 * @param {string} actualSource - 來源類型
 * @param {number} source_id - 來源 ID
 * @param {string} alert_type - 警報類型
 * @returns {Promise<Object|null>} 更新後的警報，如果不需要更新則返回 null
 */
async function handleAlertUpdate(
  existingAlert,
  severity,
  message,
  actualSource,
  source_id,
  alert_type
) {
  const currentSeverity = existingAlert.severity;
  const needsUpgrade = shouldUpgradeSeverity(currentSeverity, severity);
  const messageChanged = existingAlert.message !== message;

  if (!needsUpgrade && !messageChanged) {
    // 不需要更新，直接返回現有警報
    devLog.log(
      `[alertService] 警報已存在且未改變 | ID:${existingAlert.id} | ` +
        `${actualSource}:${source_id} | 類型:${alert_type} | 嚴重程度:${currentSeverity}`
    );
    return enrichAlert(existingAlert);
  }

  // 需要更新
  const updatedAlert = await updateAlertContent(
    existingAlert.id,
    severity,
    message
  );

  if (!updatedAlert) {
    return null;
  }

  if (needsUpgrade) {
    devLog.log(
      `[alertService] 🔄 警報已更新 | ID:${updatedAlert.id} | ${actualSource}:${source_id} | ` +
        `類型:${alert_type} | 嚴重程度:${currentSeverity} -> ${severity}`
    );
  } else {
    devLog.log(
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
  PEOPLE_COUNTING: "people_counting",
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
      -- 設備類型資訊（適用於設備來源和系統的關聯設備）
      MAX(CASE 
        WHEN a.source = 'device' THEN dt.name
        WHEN a.source IN ('environment', 'lighting', 'people_counting') THEN dt_system.name
        ELSE NULL
      END) as device_type_name,
      MAX(CASE 
        WHEN a.source = 'device' THEN dt.code
        WHEN a.source IN ('environment', 'lighting', 'people_counting') THEN dt_system.code
        ELSE NULL
      END) as device_type_code,
      -- 來源名稱（統一欄位，適用於所有來源類型）
      MAX(CASE 
        WHEN a.source = 'device' THEN d.name
        WHEN a.source IN ('environment', 'lighting', 'people_counting') THEN l.name
        ELSE NULL
      END) as source_name,
      -- 向後兼容：device_name（與 source_name 相同，當 source = 'device' 時）
      MAX(CASE WHEN a.source = 'device' THEN d.name END) as device_name,
      -- 樓層名稱（統一使用 floors 表）
      MAX(CASE 
        WHEN a.source IN ('environment', 'lighting', 'people_counting') THEN f.name 
        ELSE NULL 
      END) as floor_name
    FROM alerts a
    LEFT JOIN users ru ON a.resolved_by = ru.id
    LEFT JOIN users iu ON a.ignored_by = iu.id
    LEFT JOIN devices d ON a.source = 'device' AND a.source_id = d.id
    LEFT JOIN device_types dt ON d.type_id = dt.id
    -- 使用新架構：location_systems 關聯到 locations 和 floors
    LEFT JOIN location_systems ls ON a.source IN ('environment', 'lighting', 'people_counting') AND a.source_id = ls.id
    LEFT JOIN locations l ON ls.location_id = l.id
    LEFT JOIN floors f ON l.floor_id = f.id
    LEFT JOIN devices d_system ON ls.system_config->>'device_id' IS NOT NULL AND (ls.system_config->>'device_id')::integer = d_system.id
    LEFT JOIN device_types dt_system ON d_system.type_id = dt_system.id`;
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
    // 增量查詢：只獲取創建時間或更新時間在此之後的警報（優化輪詢效率）
    // 注意：需要同時檢查 created_at 和 updated_at，因為：
    // 1. 新創建的警報：created_at > updated_after
    // 2. 更新的警報：updated_at > updated_after
    // countQuery 不包含 updated_after 條件，因為計數應該包含所有符合條件的記錄
    if (updated_after) {
      // 使用 OR 條件檢查兩個時間戳，確保不遺漏新創建的警報
      query += " AND (a.created_at >= ? OR a.updated_at >= ?)";
      params.push(updated_after, updated_after);
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
      devLog.log(
        `[alertService] 警報已被忽視，不創建新警報: source=${actualSource}, source_id=${source_id}, alert_type=${alert_type}`
      );
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
      // 使用統一的更新處理函數
      const result = await handleAlertUpdate(
        existingAlert,
        severity,
        message,
        actualSource,
        source_id,
        alert_type
      );
      if (result) {
        return result;
      }
      // 如果返回 null，表示更新失敗，繼續創建新警報
    }

    // 沒有現有 active 警報，需要創建新警報
    // message 已在函數開頭檢查，這裡不需要重複檢查

    // 使用 INSERT 語句，如果發生並發衝突，會由唯一索引捕獲
    devLog.log(
      `[alertService] ➕ 創建新警報 | ${actualSource}:${source_id} | ` +
        `類型:${alert_type} | 嚴重程度:${severity}`
    );

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
      devLog.log(
        `[alertService] ✅ 新警報創建 | ID:${alert.id} | ${actualSource}:${source_id} | ` +
          `類型:${alert_type} | 嚴重程度:${severity}`
      );

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
          // 使用統一的更新處理函數（並發衝突處理）
          devLog.log(`[alertService] 並發衝突，重新處理警報更新`);
          const result = await handleAlertUpdate(
            retryExistingAlert,
            severity,
            message,
            actualSource,
            source_id,
            alert_type
          );
          if (result) {
            return result;
          }
          // 如果返回 null，表示更新失敗，拋出錯誤
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

    // 先查詢所有匹配的警報（用於批量處理）
    const currentAlerts = await db.query(
      `SELECT id, status FROM alerts 
			WHERE source_id = ? AND source = ? AND alert_type = ? 
			AND status != ?`,
      [sourceId, source, alertType, newStatus]
    );

    if (!currentAlerts || currentAlerts.length === 0) {
      throw new Error(
        `未找到可更新的警報（來源: ${source}, ID: ${sourceId}, 類型: ${alertType}）`
      );
    }

    // 記錄所有警報的舊狀態（用於歷史記錄和 WebSocket 事件）
    const alertIds = currentAlerts.map((a) => a.id);
    const oldStatus = currentAlerts[0].status; // 所有警報應該有相同的狀態

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

    const updatedCount = result.length;

    // 記錄狀態變更歷史和推送 WebSocket 事件（只有在狀態真正改變時）
    if (oldStatus !== newStatus && alertIds.length > 0) {
      // 為所有更新的警報記錄歷史（批量插入，使用安全的參數化查詢）
      // 使用 unnest 函數進行批量插入（PostgreSQL 優化方式）
      await db.query(
        `INSERT INTO alert_history (alert_id, old_status, new_status, changed_by, reason)
        SELECT unnest($1::integer[]), $2, $3, $4, $5`,
        [alertIds, oldStatus, newStatus, userId, reason]
      );

      // 查詢所有更新後的警報資料（用於 WebSocket 事件）
      const alertQuery = `
        SELECT 
          a.*,
          ru.username as resolved_by_username,
          iu.username as ignored_by_username
        FROM alerts a
        LEFT JOIN users ru ON a.resolved_by = ru.id
        LEFT JOIN users iu ON a.ignored_by = iu.id
        WHERE a.id = ANY($1::integer[])
      `;
      const alertResults = await db.query(alertQuery, [alertIds]);

      if (alertResults && alertResults.length > 0) {
        // 為每個更新的警報推送 WebSocket 事件
        for (const alert of alertResults) {
          const enrichedAlert = enrichAlert(alert);
          websocketService.emitAlertUpdated(
            enrichedAlert,
            oldStatus,
            newStatus
          );
        }

        // 更新並推送未解決警報數量（僅在狀態真正改變時，只推送一次）
        void emitUnresolvedAlertCount();
      }
    }

    return updatedCount;
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
    devLog.warn(
      `[alertService] 更新 error_tracking 失敗（不影響取消忽視）: ${error.message}`
    );
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
 * @param {Object} filters - 可選的篩選條件（支持時間範圍篩選）
 * @returns {Promise<number>} 未解決的警報數量
 */
async function getUnresolvedAlertCount(filters = {}) {
  try {
    const {
      source,
      source_id,
      device_id,
      alert_type,
      severity,
      start_date,
      end_date,
    } = filters;

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
    // 支持時間範圍篩選（使用 created_at，與列表查詢一致）
    if (start_date) {
      query += " AND created_at >= ?";
      params.push(start_date);
    }
    if (end_date) {
      query += " AND created_at <= ?";
      params.push(end_date);
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
      devLog.log(`[alertService] 📢 已推送未解決警報數量: ${count}`);
    } catch (error) {
      devLog.error(
        "[alertService] ❌ 推送未解決警報數量失敗: " + error.message
      );
      // 不拋出錯誤，避免影響主要流程
    } finally {
      unresolvedCountTimer = null;
    }
  }, UNRESOLVED_COUNT_DEBOUNCE_MS);
}

/**
 * 取得單一警報（通過 ID）
 * @param {number} id - 警報 ID
 * @returns {Promise<Object>} 警報對象
 */
async function getAlertById(id) {
  try {
    // 單一警報查詢不需要 GROUP BY，直接查詢並關聯相關資訊
    const query = `
      SELECT 
        a.*,
        ru.username as resolved_by_username,
        iu.username as ignored_by_username,
        -- 設備類型資訊（適用於設備來源和系統的關聯設備）
        CASE 
          WHEN a.source = 'device' THEN dt.name
          WHEN a.source IN ('environment', 'lighting', 'people_counting') THEN dt_system.name
          ELSE NULL
        END as device_type_name,
        CASE 
          WHEN a.source = 'device' THEN dt.code
          WHEN a.source IN ('environment', 'lighting', 'people_counting') THEN dt_system.code
          ELSE NULL
        END as device_type_code,
        -- 來源名稱（統一欄位，適用於所有來源類型）
        CASE 
          WHEN a.source = 'device' THEN d.name
          WHEN a.source IN ('environment', 'lighting', 'people_counting') THEN l.name
          ELSE NULL
        END as source_name,
        -- 向後兼容：device_name（與 source_name 相同，當 source = 'device' 時）
        CASE WHEN a.source = 'device' THEN d.name END as device_name,
        -- 樓層名稱（統一使用 floors 表）
        CASE 
          WHEN a.source IN ('environment', 'lighting', 'people_counting') THEN f.name 
          ELSE NULL 
        END as floor_name
      FROM alerts a
      LEFT JOIN users ru ON a.resolved_by = ru.id
      LEFT JOIN users iu ON a.ignored_by = iu.id
      LEFT JOIN devices d ON a.source = 'device' AND a.source_id = d.id
      LEFT JOIN device_types dt ON d.type_id = dt.id
      -- 使用新架構：location_systems 關聯到 locations 和 floors
      LEFT JOIN location_systems ls ON a.source IN ('environment', 'lighting', 'people_counting') AND a.source_id = ls.id
      LEFT JOIN locations l ON ls.location_id = l.id
      LEFT JOIN floors f ON l.floor_id = f.id
      LEFT JOIN devices d_system ON ls.system_config->>'device_id' IS NOT NULL AND (ls.system_config->>'device_id')::integer = d_system.id
      LEFT JOIN device_types dt_system ON d_system.type_id = dt_system.id
      WHERE a.id = ?
    `;
    const result = await db.query(query, [id]);

    if (!result || result.length === 0) {
      throw new Error(`警報 ID ${id} 不存在`);
    }

    return enrichAlert(result[0]);
  } catch (error) {
    devLog.error(`[alertService] 取得警報失敗 (ID: ${id}): ` + error.message);
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
    devLog.error(`[alertService] 取得警報歷史記錄失敗: ` + error.message);
    throw error;
  }
}

module.exports = {
  getAlerts,
  getAlertById, // 取得單一警報
  createAlert,
  updateAlertStatus,
  resolveAlert,
  ignoreAlerts,
  unignoreAlerts,
  unresolveAlert,
  isSourceIgnored,
  getUnresolvedAlertCount,
  getAlertHistory,
  findAllActiveAlerts, // 導出用於自動解決跨天警報
  ALERT_SOURCES,
  ALERT_STATUS,
  ALERT_TYPES,
  SEVERITIES,
};
