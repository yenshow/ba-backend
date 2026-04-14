const db = require("../../database/db");
const alertService = require("./alertService");
const alertRuleService = require("./alertRuleService");

/**
 * 統一錯誤追蹤服務（重構版）
 * 支持多系統來源，狀態持久化到資料庫
 * 整合 alert_rules 規則系統
 */

const ERROR_THRESHOLD = 5; // 預設閾值（如果規則不存在時使用）

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
async function recordError(
  source,
  sourceId,
  alertType,
  errorMessage,
  metadata = {},
) {
  const startTime = Date.now();

  try {
    // 1. 檢查是否已被忽視（優先檢查，避免不必要的資料庫操作）
    const isIgnored = await alertService.isSourceIgnored(
      source,
      sourceId,
      alertType,
      null,
      `${alertType}:default`,
    );
    if (isIgnored) {
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[errorTracker] ⏭️  來源 ${source}:${sourceId} 的 ${alertType} 警報已被忽視，跳過`,
        );
      }
      return false;
    }

    // 2. 使用 UPSERT 操作一次完成取得/創建和增加計數（以 source + source_id + alert_type 為維度）
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
      throw new Error("UPSERT 操作失敗");
    }

    const tracking = upsertResult[0];

    // 3. 取得規則（加 TTL cache）：確保「新增/編輯警報規則」能在短時間內生效
    const rule = await getCachedErrorCountRule(source, alertType);
    const threshold = rule?.condition_config?.min_errors || ERROR_THRESHOLD;

    // 4. 判斷是否達到閾值並創建/更新警報
    if (tracking.error_count >= threshold) {
      // 使用規則定義的嚴重程度，如果沒有規則則使用預設值
      const severity = rule?.severity || alertService.SEVERITIES.WARNING;

      // 5. 創建或更新警報
      try {
        // 構建警報資料（總是提供 message，使用達到閾值時的錯誤次數）
        const sourceName = metadata.name || `${source}:${sourceId}`;
        let message;
        if (rule) {
          message = await alertRuleService.renderRuleMessage(rule, {
            source_id: sourceId,
            error_count: threshold,
          });
        }
        if (!message) {
          message = `${sourceName} 連續 ${threshold} 次無法連接，請檢查狀態`;
        }

        const alertData = {
          source,
          source_id: sourceId,
          alert_type: alertType,
          dimension_key: `${alertType}:default`,
          severity,
          message,
          rule_id: rule?.id || null,
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
          console.log(
            `[errorTracker] ✅ 警報已創建 | ${source}:${sourceId} | ${alertType} | ` +
              `錯誤次數:${tracking.error_count}/${threshold} | 嚴重程度:${severity} | 耗時:${duration}ms`,
          );
        } else if (process.env.NODE_ENV === "development") {
          console.log(
            `[errorTracker] 🔄 警報已更新 | ${source}:${sourceId} | ${alertType} | ` +
              `錯誤次數:${tracking.error_count}/${threshold} | 耗時:${duration}ms`,
          );
        }

        return true;
      } catch (alertError) {
        console.error(
          `[errorTracker] ❌ 創建/更新警報失敗 | ${source}:${sourceId} | ${alertType}:`,
          alertError.message,
        );
        return false;
      }
    } else {
      if (
        process.env.NODE_ENV === "development" &&
        tracking.error_count % 5 === 0
      ) {
        const duration = Date.now() - startTime;
        console.log(
          `[errorTracker] 📊 錯誤計數更新 | ${source}:${sourceId} | ${alertType} | ` +
            `當前:${tracking.error_count}/${threshold} | 耗時:${duration}ms`,
        );
      }
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(
      `[errorTracker] ❌ 記錄錯誤失敗 | ${source}:${sourceId} | ${alertType} | 耗時:${duration}ms:`,
      error.message,
    );
    return false;
  }
}

/**
 * 嘗試解決指定類型的 ACTIVE 警報（內部輔助）
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @param {string|Array<string>} alertTypes - 警報類型（單一或陣列）
 * @returns {Promise<boolean>} 是否成功解決至少一筆
 */
async function resolveActiveAlerts(source, sourceId, alertTypes) {
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
        console.error(
          `[errorTracker] 自動解決警報失敗 (source: ${source}, sourceId: ${sourceId}, type: ${type}):`,
          resolveError.message,
        );
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
        const updateResult = await db.query(
          `UPDATE error_tracking
           SET error_count = 0,
               last_error_at = NULL,
               alert_created = FALSE,
               updated_at = CURRENT_TIMESTAMP
           WHERE source = ?
             AND source_id = ?
             AND alert_type = ?
             AND error_count = ?`,
          [source, sourceId, type, previousCount],
        );

        const didUpdate = (updateResult || []).length > 0;
        if (!didUpdate) {
          // 另一個併發呼叫已先完成清除；不重複 log / 不重複推後續行為
          continue;
        }

        if (hadAlert) {
          const resolvedAny = await resolveActiveAlerts(source, sourceId, [
            type,
          ]);
          console.log(
            `[errorTracker] 來源 ${source}:${sourceId} 已恢復（之前連續錯誤 ${previousCount} 次，已創建警報${resolvedAny ? "並自動解決" : ""}）`,
          );
        } else {
          console.log(
            `[errorTracker] 來源 ${source}:${sourceId} 已恢復（之前連續錯誤 ${previousCount} 次，未達警報閾值）`,
          );
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
      }
    }

    return clearedAny;
  } catch (error) {
    console.error(
      `[errorTracker] 清除錯誤狀態失敗 (source: ${source}, sourceId: ${sourceId}):`,
      error,
    );
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
    console.error(`[errorTracker] 取得錯誤追蹤失敗:`, error);
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
    console.error(`[errorTracker] 更新錯誤追蹤失敗:`, error);
  }
}

module.exports = {
  recordError,
  clearError,
  getErrorTracking,
  ERROR_THRESHOLD,
};
