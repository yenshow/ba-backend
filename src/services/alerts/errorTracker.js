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
  metadata = {}
) {
  try {
    // 檢查是否已被忽視
    const isIgnored = await alertService.isSourceIgnored(
      source,
      sourceId,
      alertType
    );
    if (isIgnored) {
      console.log(
        `[errorTracker] 來源 ${source}:${sourceId} 的 ${alertType} 警報已被忽視，跳過創建新警報`
      );
      return false;
    }

    // 取得或創建錯誤追蹤記錄
    let tracking = await getErrorTracking(source, sourceId);
    if (!tracking) {
      await createErrorTracking(source, sourceId);
      tracking = await getErrorTracking(source, sourceId);
    }

    // 增加錯誤計數
    tracking.error_count++;
    tracking.last_error_at = new Date();

    // 查詢錯誤次數規則（如果存在）
    const rule = await alertRuleService.getErrorCountRule(source, alertType);
    const threshold = rule?.condition_config?.min_errors || ERROR_THRESHOLD;

    // 如果達到閾值且尚未創建警報，則創建警報
    if (tracking.error_count >= threshold && !tracking.alert_created) {
      // 使用規則定義的嚴重程度，如果沒有規則則使用預設值
      const severity = rule?.severity || alertService.SEVERITIES.WARNING;

      // 構建警報訊息（使用規則模板或預設格式）
      const sourceName = metadata.name || `${source}:${sourceId}`;
      let alertMessage;
      if (rule?.message_template) {
        alertMessage = alertRuleService.formatMessage(rule.message_template, {
          source_name: sourceName,
          error_count: tracking.error_count,
        });
      } else {
        alertMessage = `${sourceName} 連續 ${tracking.error_count} 次無法連接，請檢查狀態`;
      }

      // 創建警報
      await alertService.createAlert({
        source,
        source_id: sourceId,
        alert_type: alertType,
        severity,
        message: alertMessage,
      });

      // 標記已創建警報
      await updateErrorTracking(source, sourceId, {
        error_count: tracking.error_count,
        last_error_at: tracking.last_error_at,
        alert_created: true,
      });

      console.log(
        `[errorTracker] 來源 ${source}:${sourceId} 連續 ${tracking.error_count} 次錯誤，已創建警報`
      );

      return true;
    } else {
      // 更新錯誤計數
      await updateErrorTracking(source, sourceId, {
        error_count: tracking.error_count,
        last_error_at: tracking.last_error_at,
      });
    }

    return false;
  } catch (error) {
    console.error(
      `[errorTracker] 記錄錯誤失敗 (source: ${source}, sourceId: ${sourceId}):`,
      error
    );
    return false;
  }
}

/**
 * 清除錯誤狀態（當來源恢復正常時）
 * 如果之前創建了警報，會自動解決對應的 offline 或 error 類型警報
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @param {string} alertType - 警報類型（可選，如果未提供則嘗試解決所有相關警報）
 * @returns {Promise<boolean>} 是否實際清除了錯誤（有錯誤記錄且已清除）
 */
async function clearError(source, sourceId, alertType = null) {
  try {
    const tracking = await getErrorTracking(source, sourceId);

    if (tracking && tracking.error_count > 0) {
      const previousCount = tracking.error_count;
      const hadAlert = tracking.alert_created;

      // 重置錯誤狀態
      await updateErrorTracking(source, sourceId, {
        error_count: 0,
        last_error_at: null,
        alert_created: false,
      });

      // 如果之前創建了警報，自動解決對應的警報
      if (hadAlert) {
        try {
          // 如果指定了 alertType，只解決該類型的警報
          // 否則嘗試解決 offline 和 error 類型的警報
          const alertTypesToResolve = alertType
            ? [alertType]
            : ["offline", "error"];

          for (const type of alertTypesToResolve) {
            try {
              // 使用 updateAlertStatus 自動解決警報（resolved_by = null 表示系統自動解決）
              await alertService.updateAlertStatus(
                sourceId,
                source,
                type,
                alertService.ALERT_STATUS.RESOLVED,
                null, // 系統自動解決，不記錄操作者
                "系統檢測到問題已恢復"
              );
            } catch (resolveError) {
              // 如果該類型的警報不存在，忽略錯誤（可能已經被解決或不存在）
              if (
                !resolveError.message.includes("未找到可更新的警報")
              ) {
                console.error(
                  `[errorTracker] 自動解決警報失敗 (source: ${source}, sourceId: ${sourceId}, type: ${type}):`,
                  resolveError.message
                );
              }
            }
          }
        } catch (error) {
          console.error(
            `[errorTracker] 自動解決警報時發生錯誤:`,
            error
          );
        }

        console.log(
          `[errorTracker] 來源 ${source}:${sourceId} 已恢復（之前連續錯誤 ${previousCount} 次，已創建警報並自動解決）`
        );
      } else {
        console.log(
          `[errorTracker] 來源 ${source}:${sourceId} 已恢復（之前連續錯誤 ${previousCount} 次，未達警報閾值）`
        );
      }

      return true; // 實際清除了錯誤
    }

    return false; // 沒有錯誤記錄或錯誤計數為 0
  } catch (error) {
    console.error(
      `[errorTracker] 清除錯誤狀態失敗 (source: ${source}, sourceId: ${sourceId}):`,
      error
    );
    return false;
  }
}

/**
 * 取得錯誤追蹤記錄
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @returns {Promise<Object|null>} 錯誤追蹤記錄
 */
async function getErrorTracking(source, sourceId) {
  try {
    const result = await db.query(
      `SELECT * FROM error_tracking 
			WHERE source = ? AND source_id = ?`,
      [source, sourceId]
    );

    return result && result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error(`[errorTracker] 取得錯誤追蹤失敗:`, error);
    return null;
  }
}

/**
 * 創建錯誤追蹤記錄
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @returns {Promise<void>}
 */
async function createErrorTracking(source, sourceId) {
  try {
    await db.query(
      `INSERT INTO error_tracking (source, source_id, error_count, alert_created)
			VALUES (?, ?, 0, FALSE)
			ON CONFLICT (source, source_id) DO NOTHING`,
      [source, sourceId]
    );
  } catch (error) {
    console.error(`[errorTracker] 創建錯誤追蹤失敗:`, error);
  }
}

/**
 * 更新錯誤追蹤記錄
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @param {Object} updates - 更新欄位
 * @returns {Promise<void>}
 */
async function updateErrorTracking(source, sourceId, updates) {
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
    // WHERE 條件的參數
    params.push(source, sourceId);

    await db.query(
      `UPDATE error_tracking 
			SET ${fields.join(", ")}
			WHERE source = ? AND source_id = ?`,
      params
    );
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
