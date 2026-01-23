/**
 * 人流統計系統監控任務
 * 注意：此模組已改為僅依賴 YSCP 事件觸發，不再使用定時任務
 * 此函數保留作為手動觸發的備用機制（目前未被使用）
 */

const externalDb = require("../../database/externalDb");
const alertService = require("../alerts/alertService");
const errorTracker = require("../alerts/errorTracker");
const {
  getPeopleCountingLocations,
  getPeopleCountingConfig,
  parseEventType,
} = require("../systems/peopleCountingService");
const logger = require("../../utils/logger");

// 追蹤最後檢查的時間戳（用於查詢新記錄）
let lastCheckTime = new Date();

// 是否已輸出過環境變數狀態（避免重複輸出）
let hasLoggedEnvStatus = false;

// 執行鎖：防止並發執行
let isChecking = false;

/**
 * 是否啟用人流監控詳細日誌
 * - 設置環境變數 ENABLE_DETAILED_LOGS=true 可啟用
 * - 目的：協助排查「WebSocket 增量更新」是否有推送/漏送
 */
function isDetailedLogsEnabled() {
  const enabled = process.env.ENABLE_DETAILED_LOGS === "true";
  // 首次調用時輸出狀態（協助排查環境變數是否正確設置）
  if (!hasLoggedEnvStatus) {
    console.log(`[peopleCountingMonitor] 詳細日誌狀態: ${enabled ? "已啟用" : "未啟用"} (ENABLE_DETAILED_LOGS=${process.env.ENABLE_DETAILED_LOGS || "未設置"})`);
    hasLoggedEnvStatus = true;
  }
  return enabled;
}

/**
 * 檢查新的刷卡記錄
 * @param {object} options - 選項
 * @param {string} options.triggerSource - 觸發來源（'scheduled' | 'yscp_event' | 'manual'）
 */
async function checkPeopleCountingRecords(options = {}) {
  const { triggerSource = "scheduled" } = options;

  // 防止並發執行
  if (isChecking) {
    logger.debug("人流統計檢查正在執行中，跳過本次觸發", {
      triggerSource,
      module: "peopleCountingMonitor",
    });
    return;
  }

  isChecking = true;

  try {
    const now = new Date();

    // 詳細日誌：記錄輪詢時間窗（每次執行都可追蹤 lastCheckTime 是否前進）
    if (isDetailedLogsEnabled() || triggerSource === "yscp_event") {
      logger.info("開始檢查人流刷卡新記錄", {
        module: "peopleCountingMonitor",
        triggerSource,
        lastCheckTime: lastCheckTime.toISOString(),
        now: now.toISOString(),
      });
    }
    
    // 查詢自上次檢查後的新記錄（只查詢未刪除的記錄）
    const sql = `
      SELECT 
        r.person_id,
        r.physical_id,
        r.swip_card_rev_time,
        r.snap_pic_url,
        p.full_name AS person_name,
        p.person_group_id AS unit_id,
        pg.name AS unit_name
      FROM baseacs.slot_card_records r
      LEFT JOIN platform.person p ON r.person_id = p.id
      LEFT JOIN platform.person_group pg ON p.person_group_id = pg.id
      WHERE r.is_deleted = false
        AND r.swip_card_rev_time > $1
        AND r.swip_card_rev_time <= $2
      ORDER BY r.swip_card_rev_time ASC
    `;

    const records = await externalDb.query(sql, [
      lastCheckTime.toISOString(),
      now.toISOString(),
    ]);

    if (records.length === 0) {
      // 更新最後檢查時間
      lastCheckTime = now;

      if (isDetailedLogsEnabled()) {
        logger.info("人流刷卡新記錄: 0 筆（更新 lastCheckTime）", {
          module: "peopleCountingMonitor",
          newLastCheckTime: lastCheckTime.toISOString(),
        });
      }
      return;
    }

    // 取得所有人流統計地點配置
    const locationsResult = await getPeopleCountingLocations();
    const allLocations = locationsResult.locations;

    // 建立地點配置映射（用於判斷事件類型和關聯地點）
    const locationConfigMap = new Map();
    allLocations.forEach((location) => {
      const { entryDoorId, exitDoorId } = getPeopleCountingConfig(location);
      // 統一 ID 型別：前端/WS event 期望 number，避免字串造成 === 比對失敗
      const locationId = location?.id != null ? Number(location.id) : null;

      // 為每個 physical_id 建立映射
      if (entryDoorId) {
        locationConfigMap.set(entryDoorId, {
          locationId,
          locationName: location.name,
          entryDoorId,
          exitDoorId,
        });
      }
      if (exitDoorId) {
        locationConfigMap.set(exitDoorId, {
          locationId,
          locationName: location.name,
          entryDoorId,
          exitDoorId,
        });
      }
    });

    if (isDetailedLogsEnabled()) {
      logger.info("取得人流統計地點配置完成", {
        module: "peopleCountingMonitor",
        locationsCount: Array.isArray(allLocations) ? allLocations.length : 0,
        mappedPhysicalIds: locationConfigMap.size,
        recordsCount: records.length,
      });
    }

    // 處理每筆記錄
    for (const record of records) {
      const physicalId = record.physical_id;
      const locationConfig = physicalId ? locationConfigMap.get(Number(physicalId)) : null;

      // 1. 檢查是否為未註冊人員（person_id = -1）
      if (record.person_id === -1) {
        // 使用 errorTracker 累積機制：達到 5 次以上才創建警報
        const locationName = locationConfig?.locationName || "未知地點";
        const deviceInfo = physicalId ? `設備 ID: ${physicalId}` : "未知設備";

        try {
          // 使用地點 ID 作為 source_id（如果找不到地點，使用 physical_id）
          const sourceId = locationConfig?.locationId || physicalId || 0;

          // 構建錯誤訊息（用於 errorTracker）
          const errorMessage = `未註冊人員刷卡 - ${locationName} (${deviceInfo})`;

          // 使用 errorTracker 記錄錯誤（會自動累積次數，達到閾值時創建警報）
          // errorTracker 內部會：
          // 1. 查詢規則獲取 min_errors 閾值（預設 5 次）
          // 2. 使用規則的 severity 和 message_template
          // 3. 達到閾值時自動創建警報
          const alertCreated = await errorTracker.recordError(
            alertService.ALERT_SOURCES.PEOPLE_COUNTING,
            sourceId,
            alertService.ALERT_TYPES.ERROR,
            errorMessage,
            {
              name: locationName,
              device_info: deviceInfo,
              physical_id: physicalId || "",
            }
          );

          if (alertCreated) {
            logger.warn("未註冊人員警報已創建（達到累積閾值）", {
              physicalId,
              locationId: sourceId,
              timestamp: record.swip_card_rev_time,
              module: "peopleCountingMonitor",
            });
          } else if (process.env.ENABLE_DETAILED_LOGS === "true") {
            logger.debug("未註冊人員事件已記錄（未達累積閾值）", {
            physicalId,
            locationId: sourceId,
            timestamp: record.swip_card_rev_time,
            module: "peopleCountingMonitor",
          });
          }
        } catch (error) {
          logger.error("記錄未註冊人員錯誤失敗", {
            error,
            record,
            module: "peopleCountingMonitor",
          });
        }
      }

      // 2. 判斷事件類型（entry/exit）- 重用 peopleCountingService 的邏輯
      const eventType = parseEventType(
        record,
        locationConfig?.entryDoorId,
        locationConfig?.exitDoorId
      );

      // 3. 記錄處理完成（不再推送 WebSocket，由前端收到 YSCP 事件後重新載入資料）
      if (isDetailedLogsEnabled()) {
        logger.info("處理人流記錄完成", {
          module: "peopleCountingMonitor",
          personId: record.person_id,
          physicalId: record.physical_id,
          swipTime: record.swip_card_rev_time,
          eventType: eventType || "failed",
          locationId: locationConfig?.locationId ?? null,
          locationName: locationConfig?.locationName || null,
        });
      }
    }

    // 更新最後檢查時間
    lastCheckTime = now;

    if (records.length > 0) {
      logger.info(`人流統計監控完成，處理 ${records.length} 筆新記錄`, {
        module: "peopleCountingMonitor",
        triggerSource,
      });
    }

    if (isDetailedLogsEnabled() || triggerSource === "yscp_event") {
      logger.info("人流統計監控: 更新 lastCheckTime 完成", {
        module: "peopleCountingMonitor",
        triggerSource,
        newLastCheckTime: lastCheckTime.toISOString(),
      });
    }
  } catch (error) {
    logger.error("人流統計監控失敗", {
      error,
      triggerSource,
      module: "peopleCountingMonitor",
    });
  } finally {
    isChecking = false;
  }
}

module.exports = {
  checkPeopleCountingRecords,
};

