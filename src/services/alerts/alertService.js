/**
 * 統一警報服務
 * 區塊：查詢 → 建立／去重 → 狀態轉移 → 日界線
 * enrichment SELECT 見 alertQueryFragments.js
 */
const db = require("../../database/db");
const runtimeConfigService = require("../platform/runtimeConfigService");
const { getCalendarDateKeyInTimeZone } = require("../../utils/alertRolloverTz");
const websocketService = require("../websocket/websocketService");
const alertLinkageService = require("./alertLinkageService");
const alertAccessDoorLinkageService = require("./alertAccessDoorLinkageService");
const alertSipRingLinkageService = require("./alertSipRingLinkageService");
const alertElevatorCallLinkageService = require("./alertElevatorCallLinkageService");
const { notifyNewAlertByEmail } = require("./alertEmailNotifier");
const { buildAlertSelectQuery } = require("./alertQueryFragments");
const { transitionAlerts, reopenAlert, closeAlertsForDailyRollover } = require("./alertStatusStore");
const logger = require("../../utils/logger");
const { getDeviceTypeName } = require("../../constants/deviceTypes");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { EVENT_COALESCE_MS } = require("../../config/realtimeTiming");

const alertLogger = logger.createLogger("alertService");

/** 忽視「僅當曆日」：設定時區下今日之 YYYY-MM-DD */
function ignoreEffectiveTodayKey() {
  const tz = runtimeConfigService.getAlerts().dailyRolloverTimezone;
  return { tz, todayKey: getCalendarDateKeyInTimeZone(new Date(), tz) };
}

// ========== 查詢／維度 ==========

/**
 * 參數匹配正則表達式（用於舊資料訊息推導維度）
 */
const PARAMETER_PATTERN =
  /\b(PM2\.5|PM10|CO2|溫度|濕度|噪音值|TVOC|HCHO|風速)\b/;

/**
 * 維度 key 正規化
 * @param {string} value
 * @returns {string}
 */
function normalizeDimensionValue(value) {
  if (!value) return "default";
  return String(value).trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * 從訊息提取參數名稱（fallback：僅在未提供 dimension_key 時使用）
 */
function extractParameterFromMessage(message) {
  if (!message) return null;
  const match = message.match(PARAMETER_PATTERN);
  return match ? match[1] : null;
}

/**
 * 生成 Incident 維度鍵（dimension_key）
 * @param {string} alertType
 * @param {string} message
 * @param {string|null} explicitDimensionKey
 * @returns {string}
 */
function resolveDimensionKey(alertType, message, explicitDimensionKey = null) {
  if (explicitDimensionKey) {
    return normalizeDimensionValue(explicitDimensionKey);
  }
  if (alertType === ALERT_TYPES.THRESHOLD) {
    const parameter = extractParameterFromMessage(message);
    if (parameter) {
      return `threshold:${normalizeDimensionValue(parameter)}`;
    }
    return "threshold:default";
  }
  return `${alertType}:default`;
}

async function queryAlerts(
  source,
  sourceId,
  alertType,
  status,
  dimensionKey = null,
  dateRange = null,
  orderBy = "updated_at DESC",
  limit = null,
) {
  let query = `SELECT * FROM alerts WHERE source = ? AND source_id = ? AND alert_type = ? AND status = ?`;
  const params = [source, sourceId, alertType, status];

  // Incident 維度鍵精準匹配
  if (dimensionKey) {
    query += " AND dimension_key = ?";
    params.push(normalizeDimensionValue(dimensionKey));
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
 * 查詢被忽視的警報（Incident key）
 * 忽視僅在「設定時區之當曆日」阻擋 createAlert；跨曆日後同列仍存在但不阻擋。
 */
async function findIgnoredAlert(
  source,
  sourceId,
  alertType,
  dimensionKey = null,
) {
  const dk =
    dimensionKey != null ? normalizeDimensionValue(dimensionKey) : "default";
  const rows = await db.query(
    `SELECT * FROM alerts
     WHERE source = ? AND source_id = ? AND alert_type = ? AND status = ?
       AND dimension_key = ? AND ignored_at IS NOT NULL
     ORDER BY ignored_at DESC NULLS LAST
     LIMIT 20`,
    [source, sourceId, alertType, ALERT_STATUS.IGNORED, dk],
  );
  const { tz, todayKey } = ignoreEffectiveTodayKey();
  for (const row of rows || []) {
    if (getCalendarDateKeyInTimeZone(row.ignored_at, tz) === todayKey) {
      return row;
    }
  }
  return null;
}

/**
 * 查詢現有的 active 警報（Incident key 精準匹配）
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string|null} dimensionKey - 維度鍵（Incident key，可選）
 * @returns {Promise<Object|null>} 現有的 active 警報，如果不存在則返回 null
 */
async function findExistingActiveAlert(
  source,
  sourceId,
  alertType,
  dimensionKey = null,
) {
  const alerts = await queryAlerts(
    source,
    sourceId,
    alertType,
    ALERT_STATUS.ACTIVE,
    dimensionKey,
    null, // Incident 不限制日期
    null, // 不需要排序
    1, // 只取第一個
  );
  return alerts.length > 0 ? alerts[0] : null;
}

/**
 * 查詢所有現有的 active 警報（不限制日期，用於自動解決跨天警報）
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string|null} dimensionKey - 維度鍵（Incident key，可選）
 * @returns {Promise<Array>} 所有現有的 active 警報列表
 */
async function findAllActiveAlerts(
  source,
  sourceId,
  alertType,
  dimensionKey = null,
) {
  return await queryAlerts(
    source,
    sourceId,
    alertType,
    ALERT_STATUS.ACTIVE,
    dimensionKey,
    null, // 不限日期
    "updated_at DESC", // 按更新時間倒序
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
  alert_type,
  origin = null,
) {
  const currentSeverity = existingAlert.severity;
  const needsUpgrade = shouldUpgradeSeverity(currentSeverity, severity);
  const messageChanged = existingAlert.message !== message;

  if (!needsUpgrade && !messageChanged) {
    // 不需要更新，直接返回現有警報
    alertLogger.debug(
      `[alertService] 警報已存在且未改變 | ID:${existingAlert.id} | ` +
        `${actualSource}:${source_id} | 類型:${alert_type} | 嚴重程度:${currentSeverity}`,
    );
    return enrichAlert(existingAlert);
  }

  // 需要更新
  const updatedAlert = await updateAlertContent(
    existingAlert.id,
    severity,
    message,
  );

  if (!updatedAlert) {
    return null;
  }

  if (needsUpgrade) {
    alertLogger.debug(
      `[alertService] 🔄 警報已更新 | ID:${updatedAlert.id} | ${actualSource}:${source_id} | ` +
        `類型:${alert_type} | 嚴重程度:${currentSeverity} -> ${severity}`,
    );
  } else {
    alertLogger.debug(
      `[alertService] 🔄 警報數值已更新 | ID:${updatedAlert.id} | ${actualSource}:${source_id} | ` +
        `類型:${alert_type} | 新 message: ${message}`,
    );
  }

  const enrichedAlert = enrichAlert(updatedAlert);
  await createAlertEvent(
    updatedAlert.id,
    "updated",
    ALERT_STATUS.ACTIVE,
    ALERT_STATUS.ACTIVE,
    {
      previous_severity: currentSeverity,
      new_severity: severity,
      message_changed: messageChanged,
      ...(origin ? { origin } : {}),
    },
    null,
  );

  // 推送 WebSocket 事件：警報更新（severity 升級或數值更新）
  websocketService.emitAlertUpdated(
    enrichedAlert,
    ALERT_STATUS.ACTIVE,
    ALERT_STATUS.ACTIVE,
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

/**
 * 寫入警報事件流（失敗不阻斷主流程）
 * @param {number} alertId
 * @param {string} eventType
 * @param {string|null} oldStatus
 * @param {string|null} newStatus
 * @param {Object|null} payload
 * @param {number|null} actorUserId
 */
async function createAlertEvent(
  alertId,
  eventType,
  oldStatus = null,
  newStatus = null,
  payload = null,
  actorUserId = null,
) {
  try {
    await db.query(
      `INSERT INTO alert_events (alert_id, event_type, old_status, new_status, payload, actor_user_id)
       VALUES (?, ?, ?, ?, ?::jsonb, ?)`,
      [
        alertId,
        eventType,
        oldStatus,
        newStatus,
        payload ? JSON.stringify(payload) : null,
        actorUserId,
      ],
    );
  } catch (error) {
    alertLogger.warn(`[alertService] 寫入 alert_events 失敗: ${error.message}`);
  }
}

// 警報系統來源（須與 initSchema `alert_source` enum 對齊）
const ALERT_SOURCES = {
  DEVICE: "device",
  ENVIRONMENT: "environment",
  LIGHTING: "lighting",
  PEOPLE_COUNTING: "people_counting",
  DRAINAGE: "drainage",
  POWER: "power",
  ENERGY: "energy",
  HVAC: "hvac",
  AIR_CIRCULATION: "air_circulation",
  FIRE: "fire",
  EMERGENCY_RESCUE: "emergency_rescue",
  SMOKE_ALARM: "smoke_alarm",
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
  DI: "di",
  DO: "do",
};

/**
 * 依來源批次更新所有 alert_type 的狀態
 * - 用於「設備停用」等情境：停用後不應持續出現 active 警示
 * - 會沿用 updateAlertStatus，確保 event/WS/count 都一致
 */
async function updateAllAlertTypesStatus(
  source,
  sourceId,
  newStatus,
  userId = null,
) {
  let total = 0;
  const alertTypes = Object.values(ALERT_TYPES);

  for (const alertType of alertTypes) {
    try {
      const n = await updateAlertStatus(
        sourceId,
        source,
        alertType,
        newStatus,
        userId,
      );
      total += Number.isFinite(n) ? n : 0;
    } catch (err) {
      if (err?.message && err.message.includes("未找到可更新的警報")) {
        continue;
      }
      throw err;
    }
  }

  return total;
}

// 嚴重程度
const SEVERITIES = {
  WARNING: "warning",
  ERROR: "error",
  CRITICAL: "critical",
};

/**
 * 警報回傳欄位正規化（保留相容欄位）
 */
function enrichAlert(alert) {
  const enriched = { ...alert };

  // 相容欄位：布林狀態
  enriched.resolved = alert.status === ALERT_STATUS.RESOLVED;
  enriched.ignored = alert.status === ALERT_STATUS.IGNORED;

  // 相容欄位：設備來源／能源設備中心告警提供 device_id（排除站級契約 source_id=1）
  if (alert.source === ALERT_SOURCES.DEVICE) {
    enriched.device_id = alert.source_id;
  } else if (
    alert.source === ALERT_SOURCES.ENERGY &&
    Number(alert.source_id) !== 1
  ) {
    enriched.device_id = alert.source_id;
  }

  // 與 source_name 同源（避免 SQL 重複三段相同 CASE）
  const display = enriched.source_name;
  if (display != null && display !== "") {
    enriched.location_name = enriched.location_name ?? display;
    enriched.source_display_name = enriched.source_display_name ?? display;
  }

  return enriched;
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
      exclude_sources,
      alert_type,
      severity,
      status,
      start_date,
      end_date,
      time_field, // 篩選時間欄位：created_at | updated_at（預設 created_at，避免影響既有呼叫端）
      updated_after, // 增量查詢：只獲取更新時間在此之後的警報
      limit = 50,
      offset = 0,
      orderBy = "updated_at",
      order = "desc",
    } = filters;

    const actualSource = source;
    const actualSourceId = source_id;
    const actualStatus = status;
    const timeFieldCol =
      time_field === "updated_at" ? "updated_at" : "created_at";

    let query = buildAlertSelectQuery("list") + ` WHERE 1=1`;
    const params = [];

    const excludeSourcesList = Array.isArray(exclude_sources)
      ? exclude_sources
      : exclude_sources != null && exclude_sources !== ""
        ? [exclude_sources]
        : [];
    if (excludeSourcesList.length > 0) {
      const placeholders = excludeSourcesList.map(() => "?").join(", ");
      query += ` AND a.source NOT IN (${placeholders})`;
      params.push(...excludeSourcesList);
    }

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
    if (start_date) {
      query += ` AND a.${timeFieldCol} >= ?`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND a.${timeFieldCol} <= ?`;
      params.push(end_date);
    }
    if (updated_after) {
      query += " AND (a.created_at >= ? OR a.updated_at >= ?)";
      params.push(updated_after, updated_after);
    }

    const validOrderBy = [
      "created_at",
      "updated_at",
      "severity",
      "alert_type",
      "status",
    ];
    const orderByCol = validOrderBy.includes(orderBy) ? orderBy : "created_at";
    const orderDirection = order.toLowerCase() === "asc" ? "ASC" : "DESC";
    // active（未解決）置頂，其餘依 orderBy／order
    query += ` ORDER BY CASE WHEN a.status = 'active'::alert_status THEN 0 ELSE 1 END ASC, a.${orderByCol} ${orderDirection}`;

    query += " LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    let alerts = await db.query(query, params);

    // 總數：同一篩選條件的列數（不包含 limit/offset/updated_after）
    let countQuery = `SELECT COUNT(*) as total FROM alerts a WHERE 1=1`;
    const countParams = [];
    if (excludeSourcesList.length > 0) {
      const placeholders = excludeSourcesList.map(() => "?").join(", ");
      countQuery += ` AND a.source NOT IN (${placeholders})`;
      countParams.push(...excludeSourcesList);
    }
    if (actualSource) {
      countQuery += " AND a.source = ?";
      countParams.push(actualSource);
    }
    if (actualSourceId) {
      countQuery += " AND a.source_id = ?";
      countParams.push(actualSourceId);
    }
    if (alert_type) {
      countQuery += " AND a.alert_type = ?";
      countParams.push(alert_type);
    }
    if (severity) {
      countQuery += " AND a.severity = ?";
      countParams.push(severity);
    }
    if (actualStatus) {
      countQuery += " AND a.status = ?";
      countParams.push(actualStatus);
    }
    if (start_date) {
      countQuery += ` AND a.${timeFieldCol} >= ?`;
      countParams.push(start_date);
    }
    if (end_date) {
      countQuery += ` AND a.${timeFieldCol} <= ?`;
      countParams.push(end_date);
    }

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult[0]?.total || 0);

    // 正規化回傳（含相容欄位）
    const enrichedAlerts = (alerts || []).map((row) =>
      enrichAlert({
        ...row,
        device_type_name: getDeviceTypeName(row.device_type_code),
      }),
    );

    return {
      alerts: enrichedAlerts,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    };
  } catch (error) {
    alertLogger.error("取得警報列表失敗", {
      error: error?.message || String(error),
      module: "alertService",
    });
    throw error;
  }
}

// ========== 建立／去重 ==========

/**
 * 創建警報
 * @param {Object} alertData - 警報資料
 * @returns {Promise<Object>} 創建的警報
 */
async function createAlert(alertData) {
  try {
    // 相容：支持 device_id
    const {
      device_id,
      source = ALERT_SOURCES.DEVICE, // 默認值，如果提供 device_id 則會被覆蓋
      source_id = device_id,
      alert_type,
      severity = SEVERITIES.WARNING,
      message,
      dimension_key = null,
      rule_id = null,
      origin = null,
    } = alertData;

    // 如果提供了 device_id，使用 device 作為 source
    const actualSource = device_id ? ALERT_SOURCES.DEVICE : source;

    if (!source_id || !alert_type) {
      throwApiError(
        C.ALERT_CREATE_VALIDATION_FAILED,
        "source_id（或 device_id）和 alert_type 為必填欄位",
      );
    }

    // message 必填（errorTracker 會總是提供）
    if (!message) {
      throwApiError(C.ALERT_CREATE_VALIDATION_FAILED, "message 為必填欄位");
    }

    // 驗證來源
    if (!Object.values(ALERT_SOURCES).includes(actualSource)) {
      throwApiError(
        C.ALERT_CREATE_VALIDATION_FAILED,
        `無效的 source: ${actualSource}。支援的來源: ${Object.values(
          ALERT_SOURCES,
        ).join(", ")}`,
      );
    }

    // 驗證警報類型
    if (!Object.values(ALERT_TYPES).includes(alert_type)) {
      throwApiError(
        C.ALERT_CREATE_VALIDATION_FAILED,
        `無效的 alert_type: ${alert_type}。支援的類型: ${Object.values(
          ALERT_TYPES,
        ).join(", ")}`,
      );
    }

    // 驗證嚴重程度
    if (!Object.values(SEVERITIES).includes(severity)) {
      throwApiError(
        C.ALERT_CREATE_VALIDATION_FAILED,
        `無效的 severity: ${severity}。支援的級別: ${Object.values(
          SEVERITIES,
        ).join(", ")}`,
      );
    }

    const resolvedDimensionKey = resolveDimensionKey(
      alert_type,
      message,
      dimension_key,
    );

    // 優先檢查是否有被忽視的 Incident（同 key）
    const ignoredAlert = await findIgnoredAlert(
      actualSource,
      source_id,
      alert_type,
      resolvedDimensionKey,
    );

    if (ignoredAlert) {
      // 如果警報已被忽視，不創建新警報（忽視功能：不再顯示相同來源和類型的警示）
      alertLogger.debug(
        `[alertService] 警報已被忽視，不創建新警報: source=${actualSource}, source_id=${source_id}, alert_type=${alert_type}`,
      );
      // 返回忽視的警報（不更新，保持忽視狀態）
      return enrichAlert(ignoredAlert);
    }

    // 先查詢現有 active Incident（同 key）
    const existingAlert = await findExistingActiveAlert(
      actualSource,
      source_id,
      alert_type,
      resolvedDimensionKey,
    );

    if (existingAlert) {
      // 使用統一的更新處理函數
      const result = await handleAlertUpdate(
        existingAlert,
        severity,
        message,
        actualSource,
        source_id,
        alert_type,
        origin,
      );
      if (result) {
        return result;
      }
      // 如果返回 null，表示更新失敗，繼續創建新警報
    }

    // 沒有現有 active 警報，需要創建新警報
    // message 已在函數開頭檢查，這裡不需要重複檢查

    // 使用 INSERT 語句，如果發生並發衝突，會由唯一索引捕獲
    alertLogger.debug(
      `[alertService] ➕ 創建新警報 | ${actualSource}:${source_id} | ` +
        `類型:${alert_type} | 嚴重程度:${severity}`,
    );

    const insertQuery = `
			INSERT INTO alerts (source, source_id, alert_type, dimension_key, rule_id, severity, message, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING *
		`;

    try {
      const insertResult = await db.query(insertQuery, [
        actualSource,
        source_id,
        alert_type,
        resolvedDimensionKey,
        rule_id,
        severity,
        message,
        ALERT_STATUS.ACTIVE,
      ]);

      const alert = insertResult[0];

      // 記錄警報創建日誌（結構化日誌）
      alertLogger.debug(
        `[alertService] ✅ 新警報創建 | ID:${alert.id} | ${actualSource}:${source_id} | ` +
          `類型:${alert_type} | 嚴重程度:${severity}`,
      );

      const enrichedAlert = enrichAlert(alert);

      // 推送 WebSocket 事件：新警報創建（優先推送，確保即時性）
      websocketService.emitAlertNew(enrichedAlert);
      await createAlertEvent(
        alert.id,
        "triggered",
        null,
        ALERT_STATUS.ACTIVE,
        {
          severity,
          source: actualSource,
          source_id,
          alert_type,
          dimension_key: resolvedDimensionKey,
          rule_id,
          ...(origin ? { origin } : {}),
        },
        null,
      );

      // 更新並推送未解決警報數量（非阻塞執行）
      emitUnresolvedAlertCount();

      // 警報連動（DI 觸發後 DO 輸出等）：非阻塞執行，避免拖慢主流程
      setImmediate(() => {
        alertLinkageService
          .processLinkagesForNewAlert(enrichedAlert)
          .catch((err) => {
            alertLogger.warn(
              `[alertService] 警報連動執行失敗 | alertId=${enrichedAlert?.id} | ${err?.message || String(err)}`,
            );
          });
        alertAccessDoorLinkageService
          .processAccessDoorLinkagesForNewAlert(enrichedAlert)
          .catch((err) => {
            alertLogger.warn(
              `[alertService] 門禁全開連動失敗 | alertId=${enrichedAlert?.id} | ${err?.message || String(err)}`,
            );
          });
        alertSipRingLinkageService
          .processSipRingLinkagesForNewAlert(enrichedAlert)
          .catch((err) => {
            alertLogger.warn(
              `[alertService] SIP 語音廣播連動失敗 | alertId=${enrichedAlert?.id} | ${err?.message || String(err)}`,
            );
          });
        alertElevatorCallLinkageService
          .processElevatorCallLinkagesForNewAlert(enrichedAlert)
          .catch((err) => {
            alertLogger.warn(
              `[alertService] 電梯呼梯連動失敗 | alertId=${enrichedAlert?.id} | ${err?.message || String(err)}`,
            );
          });
      });

      // Email 通知：僅新 active 且具 rule_id 時評估（非阻塞）
      if (enrichedAlert?.rule_id) {
        setImmediate(() => void notifyNewAlertByEmail(enrichedAlert));
      }

      return enrichedAlert;
    } catch (error) {
      // 如果唯一約束衝突（並發創建情況），再次嘗試查詢並更新
      if (
        error.code === "23505" ||
        error.message.includes("unique_active_alert") ||
        error.message.includes("idx_alerts_unique_active_key")
      ) {
        // 等待一小段時間，確保另一個事務已完成
        await new Promise((resolve) => setTimeout(resolve, 10));

        // 重新查詢現有警報（同 Incident key）
        const retryExistingAlert = await findExistingActiveAlert(
          actualSource,
          source_id,
          alert_type,
          resolvedDimensionKey,
        );

        if (retryExistingAlert) {
          // 使用統一的更新處理函數（並發衝突處理）
          alertLogger.debug(`[alertService] 並發衝突，重新處理警報更新`);
          const result = await handleAlertUpdate(
            retryExistingAlert,
            severity,
            message,
            actualSource,
            source_id,
            alert_type,
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
    alertLogger.error("創建警報失敗", {
      error: error?.message || String(error),
      module: "alertService",
    });
    throw error;
  }
}

// ========== 狀態轉移 ==========

/**
 * 標記警報為未解決（管理員功能）
 * @param {number} id - 警報 ID
 * @param {number|null} userId - 用戶 ID（可選）
 * @returns {Promise<Object>} 更新後的警報
 */
async function unresolveAlert(id, userId = null) {
  try {
    const result = await reopenAlert(id, userId);
    if (!result) {
      throwApiError(C.ALERT_NOT_FOUND, `警報 ID ${id} 不存在`);
    }

    const { alert, previousStatus: oldStatus } = result;
    const enrichedAlert = enrichAlert(alert);

    // 推送 WebSocket 事件：警報狀態更新（unresolve）
    if (oldStatus !== ALERT_STATUS.ACTIVE) {
      websocketService.emitAlertUpdated(
        enrichedAlert,
        oldStatus,
        ALERT_STATUS.ACTIVE,
      );

      // 更新並推送未解決警報數量
      emitUnresolvedAlertCount();
    }

    return enrichedAlert;
  } catch (error) {
    alertLogger.error("取消解決警報失敗", {
      id,
      error: error?.message || String(error),
      module: "alertService",
    });
    throw error;
  }
}

function publishAlertStatusChanges(alerts, oldStatus, newStatus) {
  for (const alert of alerts) {
    websocketService.emitAlertUpdated(enrichAlert(alert), oldStatus, newStatus);
  }
}

/**
 * 取消忽視 → active 前的碰撞處理（唯一索引、多筆 ignored 同鍵）
 * @returns {{ effectiveStatus: string, finalAlertIds: number[] }}
 */
async function planUnignoreToActiveSafely({
  sourceId,
  source,
  alertType,
  normalizedDimensionKey,
  currentAlerts,
  userId,
}) {
  let effectiveStatus = ALERT_STATUS.ACTIVE;
  const finalAlertIds = currentAlerts.map((a) => a.id);

  const existingActive = await db.query(
    `SELECT id FROM alerts
     WHERE source_id = ?
       AND source = ?
       AND alert_type = ?
       AND status = ?
       AND (?::varchar IS NULL OR dimension_key = ?::varchar)`,
    [
      sourceId,
      source,
      alertType,
      ALERT_STATUS.ACTIVE,
      normalizedDimensionKey,
      normalizedDimensionKey,
    ],
  );

  if (existingActive?.length > 0) {
    return {
      effectiveStatus: ALERT_STATUS.RESOLVED,
      finalAlertIds,
    };
  }

  if (currentAlerts.length <= 1) {
    return { effectiveStatus, finalAlertIds };
  }

  const sorted = [...currentAlerts].sort((a, b) => b.id - a.id);
  const resolveIds = sorted.slice(1).map((r) => r.id);
  const resolvedBatch = await transitionAlerts(
    resolveIds, ALERT_STATUS.IGNORED, ALERT_STATUS.RESOLVED,
    { reason: "dedupe_same_dimension", userId },
  );
  publishAlertStatusChanges(resolvedBatch, ALERT_STATUS.IGNORED, ALERT_STATUS.RESOLVED);
  if (resolvedBatch.length > 0) void emitUnresolvedAlertCount();
  return {
    effectiveStatus: ALERT_STATUS.ACTIVE,
    finalAlertIds: [sorted[0].id],
  };
}

/**
 * 更新警報狀態（Incident key 批次）
 * @param {number} sourceId - 來源 ID
 * @param {string} source - 來源類型
 * @param {string} alertType - 警報類型
 * @param {string} newStatus - 新狀態
 * @param {number} userId - 用戶 ID
 * @param {Object} options - 額外條件
 * @param {string|null} options.dimensionKey - 維度鍵（可選）
 * @param {string|null} options.reason - 寫入 alert_events.payload.reason（可選）
 * @returns {Promise<number>} 更新的警報數量
 */
async function updateAlertStatus(
  sourceId,
  source,
  alertType,
  newStatus,
  userId,
  options = {},
) {
  try {
    if (!Object.values(ALERT_STATUS).includes(newStatus)) {
      throwApiError(C.ALERT_STATUS_INVALID, `無效的狀態: ${newStatus}`);
    }
    const normalizedDimensionKey = options.dimensionKey
      ? normalizeDimensionValue(options.dimensionKey)
      : null;
    const expectedStatus = newStatus === ALERT_STATUS.ACTIVE
      ? ALERT_STATUS.IGNORED
      : ALERT_STATUS.ACTIVE;
    const currentAlerts = await db.query(
      `SELECT id, status FROM alerts
       WHERE source_id = ?
         AND source = ?
         AND alert_type = ?
         AND status = ?::alert_status
         AND (?::varchar IS NULL OR dimension_key = ?::varchar)`,
      [
        sourceId,
        source,
        alertType,
        expectedStatus,
        normalizedDimensionKey,
        normalizedDimensionKey,
      ],
    );

    if (!currentAlerts || currentAlerts.length === 0) {
      throwApiError(
        C.ALERT_NOT_FOUND,
        `未找到可更新的警報（來源: ${source}, ID: ${sourceId}, 類型: ${alertType}）`,
      );
    }

    const alertIds = currentAlerts.map((a) => a.id);

    let effectiveStatus = newStatus;
    let finalAlertIds = alertIds;

    if (newStatus === ALERT_STATUS.ACTIVE) {
      const planned = await planUnignoreToActiveSafely({
        sourceId,
        source,
        alertType,
        normalizedDimensionKey,
        currentAlerts,
        userId,
      });
      effectiveStatus = planned.effectiveStatus;
      finalAlertIds = planned.finalAlertIds;
    }

    const reason = newStatus === ALERT_STATUS.ACTIVE && effectiveStatus === ALERT_STATUS.RESOLVED
      ? "already_has_active_incident"
      : options.reason;
    const alertResults = await transitionAlerts(
      finalAlertIds,
      expectedStatus,
      effectiveStatus,
      { reason, userId },
    );

    if (alertResults.length === 0) {
      throwApiError(
        C.ALERT_NOT_FOUND,
        `未找到可更新的警報（來源: ${source}, ID: ${sourceId}, 類型: ${alertType}）`,
      );
    }

    publishAlertStatusChanges(alertResults, expectedStatus, effectiveStatus);

    void emitUnresolvedAlertCount();

    if (
      effectiveStatus === ALERT_STATUS.RESOLVED &&
      runtimeConfigService.getAlerts()?.linkageRevertOnResolve !== false
    ) {
      try {
        await alertLinkageService.revertLinkagesForResolvedAlerts(alertResults);
      } catch (linkErr) {
        alertLogger.warn("結案後連動 DO 復歸失敗（略過）", {
          error: linkErr?.message || String(linkErr),
          module: "alertService",
        });
      }
    }

    return alertResults.length;
  } catch (error) {
    // 如果錯誤是"未找到可更新的警報"，這是正常情況（警報可能不存在或已經被解決）
    // 不記錄為錯誤，直接拋出讓調用者處理
    if (error.message && error.message.includes("未找到可更新的警報")) {
      throw error; // 直接拋出，不記錄
    }
    // 其他錯誤才記錄
    alertLogger.error("更新警報狀態失敗", {
      error: error?.message || String(error),
      module: "alertService",
    });
    throw error;
  }
}

/**
 * 標記警示為已解決（支持多系統來源，一律為系統自動解決）
 * @param {number} sourceId - 來源 ID（設備 ID、位置 ID 等）
 * @param {string} alertType - 警報類型
 * @param {string} source - 系統來源（可選，默認為 device）
 * @returns {Promise<number>} 更新的警示數量
 */
async function resolveAlert(
  sourceId,
  alertType,
  source = ALERT_SOURCES.DEVICE,
  dimensionKey = null,
) {
  return await updateAlertStatus(
    sourceId,
    source,
    alertType,
    ALERT_STATUS.RESOLVED,
    null,
    { dimensionKey, reason: "recovered" },
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
  source = ALERT_SOURCES.DEVICE,
  dimensionKey = null,
) {
  return await updateAlertStatus(
    sourceId,
    source,
    alertType,
    ALERT_STATUS.IGNORED,
    ignoredBy,
    { dimensionKey },
  );
}

/**
 * 檢查來源是否已被忽視
 * @param {string} source - 來源類型
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string|null} message - 警報訊息（可選，用於推導維度鍵）
 * @param {string|null} explicitDimensionKey - 明確維度鍵（優先）
 * @returns {Promise<boolean>} 是否已被忽視
 */
async function isSourceIgnored(
  source,
  sourceId,
  alertType,
  message = null,
  explicitDimensionKey = null,
) {
  try {
    const dimensionKey = resolveDimensionKey(
      alertType,
      message,
      explicitDimensionKey,
    );
    const rows = await db.query(
      `SELECT id, ignored_at FROM alerts
       WHERE source = ?
         AND source_id = ?
         AND alert_type = ?
         AND status = ?
         AND dimension_key = ?
         AND ignored_at IS NOT NULL
       ORDER BY ignored_at DESC NULLS LAST
       LIMIT 20`,
      [source, sourceId, alertType, ALERT_STATUS.IGNORED, dimensionKey],
    );
    const { tz, todayKey } = ignoreEffectiveTodayKey();
    return (rows || []).some(
      (r) =>
        r.ignored_at &&
        getCalendarDateKeyInTimeZone(r.ignored_at, tz) === todayKey,
    );
  } catch (error) {
    alertLogger.error("檢查忽視狀態失敗", {
      error: error?.message || String(error),
      module: "alertService",
    });
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
      exclude_sources,
      alert_type,
      severity,
      start_date,
      end_date,
      time_field, // created_at | updated_at（預設 created_at）
    } = filters;

    const actualSource = source;
    const actualSourceId = source_id;
    const timeFieldCol =
      time_field === "updated_at" ? "updated_at" : "created_at";

    let query = `
			SELECT
        COUNT(DISTINCT (source::text || '-' || source_id::text || '-' || alert_type::text || '-' || COALESCE(dimension_key, 'default'))) as count,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT dimension_key), NULL) as dimension_keys,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT rule_id), NULL) as rule_ids
			FROM alerts
			WHERE status = ?
		`;
    const params = [ALERT_STATUS.ACTIVE];

    const excludeSourcesList = Array.isArray(exclude_sources)
      ? exclude_sources
      : exclude_sources != null && exclude_sources !== ""
        ? [exclude_sources]
        : [];
    if (excludeSourcesList.length > 0) {
      const placeholders = excludeSourcesList.map(() => "?").join(", ");
      query += ` AND source NOT IN (${placeholders})`;
      params.push(...excludeSourcesList);
    }

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
    // 支持時間範圍篩選（預設 created_at；可用 time_field=updated_at 改為更新時間）
    if (start_date) {
      query += ` AND ${timeFieldCol} >= ?`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND ${timeFieldCol} <= ?`;
      params.push(end_date);
    }

    const result = await db.query(query, params);
    const row = result[0] || {};
    return {
      count: parseInt(row.count || 0),
      dimension_keys: row.dimension_keys || [],
      rule_ids: row.rule_ids || [],
    };
  } catch (error) {
    alertLogger.error("取得未解決警報數量失敗", {
      error: error?.message || String(error),
      module: "alertService",
    });
    throw error;
  }
}

// 防抖計時器，避免頻繁推送未解決警報數量（優化：減少資料庫查詢和 WebSocket 推送）
let unresolvedCountTimer = null;

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
      const countResult = await getUnresolvedAlertCount({});
      const n =
        typeof countResult === "number"
          ? countResult
          : parseInt(String(countResult?.count ?? 0), 10);
      websocketService.emitAlertCount(Number.isFinite(n) ? n : 0);
      alertLogger.debug(
        `[alertService] 📢 已推送未解決警報數量（狀態型、全量 active）: ${n}`,
      );
    } catch (error) {
      alertLogger.error(
        "[alertService] ❌ 推送未解決警報數量失敗: " + error.message,
      );
      // 不拋出錯誤，避免影響主要流程
    } finally {
      unresolvedCountTimer = null;
    }
  }, EVENT_COALESCE_MS);
}

// ========== 日界線 ==========

/**
 * 日界線：將所有 active 批次結案為 resolved，寫入 alert_events、連動 DO 復歸、廣播 alert:daily_rollover 與 alert:count
 * @returns {Promise<{ resolvedCount: number }>}
 */
async function resolveAllActiveForDailyRollover() {
  const tz = runtimeConfigService.getAlerts().dailyRolloverTimezone;
  const occurredAt = new Date().toISOString();
  const snapshot = await db.query(`SELECT * FROM alerts WHERE status = ?`, [
    ALERT_STATUS.ACTIVE,
  ]);
  let resolvedCount = 0;
  let ignoredResolvedCount = 0;

  if ((snapshot?.length ?? 0) > 0) {
    try {
      await alertLinkageService.revertLinkagesForDailyRollover(snapshot);
    } catch (linkErr) {
      alertLogger.warn(
        `[alertService] 日界線連動復歸部分失敗: ${linkErr?.message || linkErr}`,
      );
    }
  }

  try {
    const counts = await closeAlertsForDailyRollover();
    resolvedCount = counts.activeCount;
    ignoredResolvedCount = counts.ignoredCount;
  } catch (err) {
    alertLogger.error("日界線批次結案失敗", {
      error: err?.message || String(err),
      module: "alertService",
    });
    throw err;
  }

  if (resolvedCount > 0) {
    alertLogger.debug(`[alertService] 日界線結案完成: ${resolvedCount} 筆 active`);
  }
  if (ignoredResolvedCount > 0) {
    alertLogger.debug(
      `[alertService] 日界線 ignored 結案完成: ${ignoredResolvedCount} 筆`,
    );
  }

  const totalResolved = resolvedCount + ignoredResolvedCount;
  websocketService.emitAlertDailyRollover({
    resolvedCount: totalResolved,
    occurredAt,
    timezone: tz,
  });
  emitUnresolvedAlertCount();
  return { resolvedCount: totalResolved, ignoredResolvedCount };
}

/**
 * 取得單一警報（通過 ID）
 * @param {number} id - 警報 ID
 * @returns {Promise<Object>} 警報對象
 */
async function getAlertById(id) {
  try {
    const query = `${buildAlertSelectQuery("byId")}
      WHERE a.id = ?`;
    const result = await db.query(query, [id]);

    if (!result || result.length === 0) {
      throwApiError(C.ALERT_NOT_FOUND, `警報 ID ${id} 不存在`);
    }

    const row = result[0];
    return enrichAlert({
      ...row,
      device_type_name: getDeviceTypeName(row.device_type_code),
    });
  } catch (error) {
    alertLogger.error(`[alertService] 取得警報失敗 (ID: ${id}): ` + error.message);
    throw error;
  }
}

/**
 * 取得已解決的過期警報（含關聯資訊）供備份使用
 * @param {Date} beforeDate - 備份此日期之前的已解決警報
 */
async function getResolvedAlertsForBackup(beforeDate, startDate = "-infinity") {
  const query = `${buildAlertSelectQuery("backup")}
    WHERE a.status = 'resolved' AND a.updated_at < ? AND a.updated_at >= ?
    ORDER BY a.updated_at ASC`;
  const result = await db.query(query, [beforeDate, startDate]);
  return (result || []).map((row) =>
    enrichAlert({
      ...row,
      device_type_name: getDeviceTypeName(row.device_type_code),
    }),
  );
}

module.exports = {
  getAlerts,
  getAlertById, // 取得單一警報
  getResolvedAlertsForBackup,
  createAlert,
  updateAlertStatus,
  updateAllAlertTypesStatus,
  resolveAlert,
  ignoreAlerts,
  unresolveAlert,
  isSourceIgnored,
  getUnresolvedAlertCount,
  resolveAllActiveForDailyRollover,
  findAllActiveAlerts,
  ALERT_SOURCES,
  ALERT_STATUS,
  ALERT_TYPES,
  SEVERITIES,
};
