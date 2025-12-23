const db = require("../../database/db");
const alertService = require("./alertService");

/**
 * 統一錯誤追蹤服務（重構版）
 * 支持多系統來源，狀態持久化到資料庫
 */

const ERROR_THRESHOLD = 5;

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

    // 如果達到閾值且尚未創建警報，則創建警報
    if (tracking.error_count >= ERROR_THRESHOLD && !tracking.alert_created) {
      const severity =
        tracking.error_count >= ERROR_THRESHOLD * 2
          ? alertService.SEVERITIES.CRITICAL
          : alertService.SEVERITIES.WARNING;

      // 構建警報訊息
      const sourceName = metadata.name || `${source}:${sourceId}`;
      const alertMessage = `${sourceName} 連續 ${tracking.error_count} 次無法連接，請檢查狀態`;

      // 創建警報
      await alertService.createAlert({
        source,
        source_id: sourceId,
        source_type: metadata.type,
        alert_type: alertType,
        severity,
        message: alertMessage,
        metadata,
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
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源實體 ID
 * @returns {Promise<void>}
 */
async function clearError(source, sourceId) {
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

      if (hadAlert) {
        console.log(
          `[errorTracker] 來源 ${source}:${sourceId} 已恢復（之前連續錯誤 ${previousCount} 次，已創建警報）`
        );
      } else {
        console.log(
          `[errorTracker] 來源 ${source}:${sourceId} 已恢復（之前連續錯誤 ${previousCount} 次，未達警報閾值）`
        );
      }
    }
  } catch (error) {
    console.error(
      `[errorTracker] 清除錯誤狀態失敗 (source: ${source}, sourceId: ${sourceId}):`,
      error
    );
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
