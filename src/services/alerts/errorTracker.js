const db = require("../../database/db");
const alertRuleService = require("./alertRuleService");
const { summaryOfflineFallback, resolveSourceLabel } = require("./alertCopy");
const logger = require("../../utils/logger");

const trackerLogger = logger.createLogger("errorTracker");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

/**
 * 統一錯誤追蹤服務（重構版）
 * 支持多系統來源，狀態持久化到資料庫
 * 整合 alert_rules 規則系統
 *
 * **呼叫約定**：業務層連線／快照請優先經 `systemAlertHelper`（`recordError`／`clearError`／
 * `syncLocationSnapshotReadResult`／`notifyModbusHttpDevice*`）；本檔為計數、`error_tracking` 與
 * incident 解決的底層實作。`alertService.unignoreAlerts` 後續僅呼叫 `reconcileTrackingAfterUnignore`。
 *
 * **無規則不發送**：`source`+`alert_type` 若無啟用的 `error_count` 規則，不寫入計數、不建立警報。
 */

/**
 * 規則快取（error_count 只會用到 source+alertType 這一維）
 * 目的：避免 recordError 每次都查 DB，但仍能在「剛更新規則」後很快生效。
 */
const errorCountRuleCache = new Map();
const ERROR_RULE_CACHE_TTL_MS = 1_000;

async function getCachedErrorCountRule(source, alertType) {
  const key = `${String(source)}:${String(alertType)}`;
  const cached = errorCountRuleCache.get(key);
  if (cached && Date.now() - cached.ts < ERROR_RULE_CACHE_TTL_MS) {
    return cached.rule;
  }
  const rule = await alertRuleService.getErrorCountRule(source, alertType);
  errorCountRuleCache.set(key, { rule: rule || null, ts: Date.now() });
  return rule || null;
}

/**
 * 記錄錯誤（支持多系統來源）
 * @param {string} source - 系統來源 (device, environment, lighting 等)
 * @param {number} sourceId - 來源實體 ID
 * @param {string} alertType - 警報類型
 * @param {string} errorMessage - 錯誤訊息
 * @param {Object} metadata - 額外資訊（設備名稱、位置等）
 * @returns {Promise<boolean>} 是否創建了警報
 */
async function recordErrorDetailed(
  source,
  sourceId,
  alertType,
  errorMessage,
  metadata = {},
) {
  const startTime = Date.now();

  try {
    // 延遲載入：避免與 alertService 循環依賴造成啟動期脆弱
    const alertService = require("./alertService");

    // 1. 檢查是否已被忽視（優先檢查，避免不必要的資料庫操作）
    const isIgnored = await alertService.isSourceIgnored(
      source,
      sourceId,
      alertType,
      null,
      `${alertType}:default`,
    );
    if (isIgnored) {
      trackerLogger.debug("來源警報已被忽視，跳過錯誤計數", {
        source,
        sourceId,
        alertType,
        module: "errorTracker",
      });
      return {
        ignored: true,
        trackingUpdated: false,
        errorCount: 0,
        threshold: 0,
        thresholdReached: false,
        alertCreated: false,
      };
    }

    // 2. 必須有啟用的 error_count 規則才計數／建警報（無規則則不寫入 error_tracking、不發送）
    const rule = await getCachedErrorCountRule(source, alertType);
    if (!rule) {
      trackerLogger.debug("無啟用的錯誤次數規則，略過計數與警報", {
        source,
        sourceId,
        alertType,
        module: "errorTracker",
      });
      return {
        ignored: false,
        trackingUpdated: false,
        errorCount: 0,
        threshold: 0,
        thresholdReached: false,
        alertCreated: false,
      };
    }

    const rawMin = rule.condition_config?.min_errors;
    const parsedMin = Number(rawMin);
    const threshold =
      Number.isFinite(parsedMin) && parsedMin >= 1 ? Math.floor(parsedMin) : 1;

    // 3. 使用 UPSERT 操作一次完成取得/創建和增加計數（以 source + source_id + alert_type 為維度）
    const now = new Date();
    const upsertResult = await db.query(
      `INSERT INTO error_tracking (source, source_id, alert_type, error_count, last_error_at, alert_created, updated_at)
      VALUES (?, ?, ?, 1, ?, FALSE, CURRENT_TIMESTAMP)
      ON CONFLICT (source, source_id, alert_type) 
      DO UPDATE SET 
        error_count = error_tracking.error_count + 1,
        last_error_at = ?,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [source, sourceId, alertType, now, now],
    );

    if (!upsertResult || upsertResult.length === 0) {
      throwApiError(C.ALERT_ERROR_TRACKER_UPSERT_FAILED, "UPSERT 操作失敗", {
        statusCode: 500,
      });
    }

    const tracking = upsertResult[0];

    const thresholdReached = tracking.error_count >= threshold;

    // 4. 判斷是否達到閾值並創建/更新警報
    if (thresholdReached) {
      const severity = rule.severity || alertService.SEVERITIES.WARNING;

      // 5. 創建或更新警報
      try {
        // 構建警報資料（總是提供 message，使用達到閾值時的錯誤次數）
        const sourceName = metadata.name || resolveSourceLabel(source);
        let message = await alertRuleService.renderRuleMessage(rule, {
          source_id: sourceId,
          error_count: threshold,
        });
        if (!message) {
          message = summaryOfflineFallback({
            sourceDisplayName: sourceName,
            sourceLabel: resolveSourceLabel(source),
            errorCount: threshold,
          });
        }
        const alertData = {
          source,
          source_id: sourceId,
          alert_type: alertType,
          dimension_key: `${alertType}:default`,
          severity,
          // Message should be user-facing and stable; keep debug/trace in `origin`.
          message,
          rule_id: rule.id,
          origin: metadata?.origin || null,
        };

        await alertService.createAlert(alertData);

        // 如果是首次創建警報，標記已創建
        const isFirstCreation = !tracking.alert_created;
        if (isFirstCreation) {
          await db.query(
            `UPDATE error_tracking SET alert_created = TRUE
            WHERE source = ? AND source_id = ? AND alert_type = ?`,
            [source, sourceId, alertType],
          );
        }

        const duration = Date.now() - startTime;
        if (isFirstCreation) {
          trackerLogger.info("警報已創建（達閾值）", {
            source,
            sourceId,
            alertType,
            errorCount: tracking.error_count,
            threshold,
            severity,
            durationMs: duration,
            module: "errorTracker",
          });
        } else {
          trackerLogger.debug("警報已更新（達閾值）", {
            source,
            sourceId,
            alertType,
            errorCount: tracking.error_count,
            threshold,
            durationMs: duration,
            module: "errorTracker",
          });
        }

        return {
          ignored: false,
          trackingUpdated: true,
          errorCount: tracking.error_count,
          threshold,
          thresholdReached: true,
          alertCreated: true,
        };
      } catch (alertError) {
        trackerLogger.error("創建/更新警報失敗", {
          source,
          sourceId,
          alertType,
          error: alertError?.message || String(alertError),
          module: "errorTracker",
        });
        return {
          ignored: false,
          trackingUpdated: true,
          errorCount: tracking.error_count,
          threshold,
          thresholdReached: true,
          alertCreated: false,
        };
      }
    } else {
      // 例行輪詢避免刷屏：僅用 debug，是否輸出交由 logger 層控制
      if (tracking.error_count % 5 === 0) {
        const duration = Date.now() - startTime;
        trackerLogger.debug("錯誤計數更新（未達閾值）", {
          source,
          sourceId,
          alertType,
          errorCount: tracking.error_count,
          threshold,
          durationMs: duration,
          module: "errorTracker",
        });
      }
      return {
        ignored: false,
        trackingUpdated: true,
        errorCount: tracking.error_count,
        threshold,
        thresholdReached: false,
        alertCreated: false,
      };
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    trackerLogger.error("記錄錯誤失敗", {
      source,
      sourceId,
      alertType,
      durationMs: duration,
      error: error?.message || String(error),
      module: "errorTracker",
    });
    return {
      ignored: false,
      trackingUpdated: false,
      errorCount: 0,
      threshold: 0,
      thresholdReached: false,
      alertCreated: false,
      error: error.message,
    };
  }
}

function buildOriginSuffix(origin) {
  const parts = [];
  const channel = origin?.channel ? String(origin.channel) : null;
  if (channel) parts.push(channel);
  if (origin?.systemKey && origin?.sourceId != null) {
    parts.push(`${origin.systemKey}:${origin.sourceId}`);
  }
  if (origin?.deviceId != null) parts.push(`device:${origin.deviceId}`);
  if (origin?.host && origin?.port != null) parts.push(`${origin.host}:${origin.port}`);
  if (parts.length === 0) return "";
  return `（來源:${parts.join(" / ")}）`;
}

/**
 * 記錄錯誤（支持多系統來源）
 * @returns {Promise<boolean>} 是否創建了警報
 */
async function recordError(source, sourceId, alertType, errorMessage, metadata = {}) {
  const result = await recordErrorDetailed(
    source,
    sourceId,
    alertType,
    errorMessage,
    metadata,
  );
  return Boolean(result?.alertCreated);
}

/**
 * 嘗試解決指定類型的 ACTIVE 警報（內部輔助）
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @param {string|Array<string>} alertTypes - 警報類型（單一或陣列）
 * @returns {Promise<boolean>} 是否成功解決至少一筆
 */
async function resolveActiveAlerts(source, sourceId, alertTypes) {
  const alertService = require("./alertService");
  const types = Array.isArray(alertTypes) ? alertTypes : [alertTypes];
  let resolvedAny = false;

  for (const type of types) {
    try {
      await alertService.updateAlertStatus(
        sourceId,
        source,
        type,
        alertService.ALERT_STATUS.RESOLVED,
        null,
      );
      resolvedAny = true;
    } catch (resolveError) {
      // 如果警報不存在或已解決，忽略錯誤（這是正常情況）
      if (!resolveError.message.includes("未找到可更新的警報")) {
        trackerLogger.error("自動解決警報失敗", {
          source,
          sourceId,
          alertType: type,
          error: resolveError?.message || String(resolveError),
          module: "errorTracker",
        });
      }
    }
  }

  return resolvedAny;
}

/**
 * 清除錯誤狀態（來源恢復時呼叫）；若有警報則自動解決 offline/error 類型
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @param {string} [alertType] - 警報類型，未提供則解決 offline、error
 * @returns {Promise<boolean>} 是否實際清除
 */
async function clearError(source, sourceId, alertType = null) {
  try {
    const alertService = require("./alertService");
    const alertTypesToResolve = alertType ? [alertType] : ["offline", "error"];

    // 逐一處理每種 alertType 的 tracking 記錄
    let clearedAny = false;
    for (const type of alertTypesToResolve) {
      const tracking = await getErrorTracking(source, sourceId, type);

      if (!tracking) {
        const resolved = await resolveActiveAlerts(source, sourceId, [type]);
        if (resolved) clearedAny = true;
        continue;
      }

      if (tracking.error_count > 0) {
        const previousCount = tracking.error_count;
        const hadAlert = tracking.alert_created;

        // 去重：在多個 monitor 同時 clearError 時，只有「第一個成功把 error_count 從 previousCount 變成 0」者才輸出恢復訊息
        // 以 RETURNING 確保 `rows` 能反映是否命中（pg: UPDATE 無 RETURNING 時 rows 為空陣列）
        const updateResult = await db.query(
          `UPDATE error_tracking
           SET error_count = 0,
               last_error_at = NULL,
               alert_created = FALSE,
               updated_at = CURRENT_TIMESTAMP
           WHERE source = ?
             AND source_id = ?
             AND alert_type = ?
             AND error_count = ?
           RETURNING source`,
          [source, sourceId, type, previousCount],
        );

        const didUpdate = (updateResult?.length ?? 0) > 0;
        if (!didUpdate) {
          // 另一個併發呼叫已先完成清除；不重複 log / 不重複推後續行為
          continue;
        }

        if (hadAlert) {
          const resolvedAny = await resolveActiveAlerts(source, sourceId, [
            type,
          ]);
          trackerLogger.info("來源已恢復", {
            source,
            sourceId,
            alertType: type,
            previousErrorCount: previousCount,
            hadAlert: true,
            resolvedAny,
            module: "errorTracker",
          });
        } else {
          trackerLogger.debug("來源已恢復（未達閾值）", {
            source,
            sourceId,
            alertType: type,
            previousErrorCount: previousCount,
            hadAlert: false,
            module: "errorTracker",
          });
        }

        clearedAny = true;
        continue;
      }

      if (tracking.alert_created) {
        const resolvedAny = await resolveActiveAlerts(source, sourceId, [type]);
        if (resolvedAny) {
          await updateErrorTracking(
            source,
            sourceId,
            {
              alert_created: false,
            },
            type,
          );
        }
        clearedAny = clearedAny || resolvedAny;
        continue;
      }

      // 自癒殘留：tracking 為 error_count=0 / alert_created=false，但仍有 active 警報
      // （過去版本曾因 UPDATE 無 RETURNING 誤判 didUpdate=false 未 resolve），需補資源復歸
      const resolvedAny = await resolveActiveAlerts(source, sourceId, [type]);
      if (resolvedAny) {
        trackerLogger.info("來源已恢復（自癒殘留 active 警報）", {
          source,
          sourceId,
          alertType: type,
          module: "errorTracker",
        });
        clearedAny = true;
      }
    }

    return clearedAny;
  } catch (error) {
    trackerLogger.error("清除錯誤狀態失敗", {
      source,
      sourceId,
      error: error?.message || String(error),
      module: "errorTracker",
    });
    return false;
  }
}

/**
 * 取得錯誤追蹤記錄
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @param {string} [alertType] - 警報類型；未提供時回傳該 (source, source_id) 的所有記錄中 error_count 最高者
 * @returns {Promise<Object|null>} 錯誤追蹤記錄
 */
async function getErrorTracking(source, sourceId, alertType = null) {
  try {
    if (alertType) {
      const result = await db.query(
        `SELECT * FROM error_tracking 
        WHERE source = ? AND source_id = ? AND alert_type = ?`,
        [source, sourceId, alertType],
      );
      return result && result.length > 0 ? result[0] : null;
    }
    const result = await db.query(
      `SELECT * FROM error_tracking 
      WHERE source = ? AND source_id = ?
      ORDER BY error_count DESC LIMIT 1`,
      [source, sourceId],
    );
    return result && result.length > 0 ? result[0] : null;
  } catch (error) {
    trackerLogger.error("取得錯誤追蹤失敗", {
      source,
      sourceId,
      alertType,
      error: error?.message || String(error),
      module: "errorTracker",
    });
    return null;
  }
}

/**
 * 更新錯誤追蹤記錄
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @param {Object} updates - 更新欄位
 * @param {string} [alertType] - 警報類型；未提供時更新該 (source, source_id) 的所有記錄
 * @returns {Promise<void>}
 */
async function updateErrorTracking(
  source,
  sourceId,
  updates,
  alertType = null,
) {
  try {
    const fields = [];
    const params = [];

    if (updates.error_count !== undefined) {
      fields.push("error_count = ?");
      params.push(updates.error_count);
    }
    if (updates.last_error_at !== undefined) {
      fields.push("last_error_at = ?");
      params.push(updates.last_error_at);
    }
    if (updates.alert_created !== undefined) {
      fields.push("alert_created = ?");
      params.push(updates.alert_created);
    }

    fields.push("updated_at = CURRENT_TIMESTAMP");
    params.push(source, sourceId);

    if (alertType) {
      params.push(alertType);
      await db.query(
        `UPDATE error_tracking 
        SET ${fields.join(", ")}
        WHERE source = ? AND source_id = ? AND alert_type = ?`,
        params,
      );
    } else {
      await db.query(
        `UPDATE error_tracking 
        SET ${fields.join(", ")}
        WHERE source = ? AND source_id = ?`,
        params,
      );
    }
  } catch (error) {
    trackerLogger.error("更新錯誤追蹤失敗", {
      source,
      sourceId,
      alertType: alertType || null,
      error: error?.message || String(error),
      module: "errorTracker",
    });
  }
}

/**
 * 取消忽視後：補齊 `error_tracking` 並在已無累計錯誤時清除離線／錯誤警報
 *（原 `alertService.unignoreAlerts` 內聯邏輯，集中於此）
 */
async function reconcileTrackingAfterUnignore(source, sourceId, alertType) {
  await db.query(
    `UPDATE error_tracking 
      SET alert_created = TRUE, updated_at = CURRENT_TIMESTAMP
      WHERE source = ? AND source_id = ? AND alert_created = FALSE`,
    [source, sourceId],
  );

  const tracking = await getErrorTracking(source, sourceId, alertType);
  if (tracking && tracking.error_count === 0) {
    await clearError(source, sourceId, alertType);
  }
}

module.exports = {
  recordError,
  recordErrorDetailed,
  clearError,
  getErrorTracking,
  reconcileTrackingAfterUnignore,
};
