/**
 * 人流統計系統監控任務
 * 注意：此模組已改為僅依賴 YSCP 事件觸發，不再使用定時任務
 * 此函數保留作為手動觸發的備用機制（目前未被使用）
 */

const externalDb = require("../../database/externalDb");
const {
  getPeopleCountingLocations,
  getPeopleCountingConfig,
  parseEventType,
} = require("../systems/peopleCountingService");
const logger = require("../../utils/logger");

// 追蹤最後檢查的時間戳（用於查詢新記錄）
let lastCheckTime = new Date();

// 執行鎖：防止並發執行
let isChecking = false;

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

    // 記錄輪詢時間窗：YSCP 事件觸發用 info，其餘用 debug（避免例行輪詢刷屏）
    if (triggerSource === "yscp_event") {
      logger.info("開始檢查人流刷卡新記錄", {
        module: "peopleCountingMonitor",
        triggerSource,
        lastCheckTime: lastCheckTime.toISOString(),
        now: now.toISOString(),
      });
    } else {
      logger.debug("開始檢查人流刷卡新記錄", {
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

      logger.debug("人流刷卡新記錄: 0 筆（更新 lastCheckTime）", {
        module: "peopleCountingMonitor",
        triggerSource,
        newLastCheckTime: lastCheckTime.toISOString(),
      });
      return;
    }

    // 取得所有人流統計地點配置
    const locationsResult = await getPeopleCountingLocations();
    const allLocations = locationsResult.locations;

    // 建立地點配置映射（用於判斷事件類型和關聯地點）
    const locationConfigMap = new Map();
    allLocations.forEach((location) => {
      const { entryDoorIds, exitDoorIds } = getPeopleCountingConfig(location);
      // 統一 ID 型別：前端/WS event 期望 number，避免字串造成 === 比對失敗
      const locationId = location?.id != null ? Number(location.id) : null;

      // 為每個 physical_id 建立映射
      const entryIds = Array.isArray(entryDoorIds) ? entryDoorIds : [];
      const exitIds = Array.isArray(exitDoorIds) ? exitDoorIds : [];
      for (const id of entryIds) {
        const n = Number(id);
        if (!Number.isFinite(n) || n <= 0) continue;
        locationConfigMap.set(n, {
          locationId,
          locationName: location.name,
          entryDoorIds: entryIds,
          exitDoorIds: exitIds,
        });
      }
      for (const id of exitIds) {
        const n = Number(id);
        if (!Number.isFinite(n) || n <= 0) continue;
        locationConfigMap.set(n, {
          locationId,
          locationName: location.name,
          entryDoorIds: entryIds,
          exitDoorIds: exitIds,
        });
      }
    });

    logger.debug("取得人流統計地點配置完成", {
      module: "peopleCountingMonitor",
      locationsCount: Array.isArray(allLocations) ? allLocations.length : 0,
      mappedPhysicalIds: locationConfigMap.size,
      recordsCount: records.length,
    });

    // 處理每筆記錄
    for (const record of records) {
      const physicalId = record.physical_id;
      const locationConfig = physicalId ? locationConfigMap.get(Number(physicalId)) : null;

      // 判斷事件類型（entry/exit）- 重用 peopleCountingService 的邏輯
      const eventType = parseEventType(
        record,
        locationConfig?.entryDoorIds,
        locationConfig?.exitDoorIds
      );

      // 記錄處理完成（不再推送 WebSocket，由前端收到 YSCP 事件後重新載入資料）
      logger.debug("處理人流記錄完成", {
        module: "peopleCountingMonitor",
        triggerSource,
        personId: record.person_id,
        physicalId: record.physical_id,
        swipTime: record.swip_card_rev_time,
        eventType: eventType || "failed",
        locationId: locationConfig?.locationId ?? null,
        locationName: locationConfig?.locationName || null,
      });
    }

    // 更新最後檢查時間
    lastCheckTime = now;

    // 只有真正有新資料才用 INFO（有意義事件）；其餘用 debug
    if (records.length > 0) {
      logger.info(`人流統計監控完成，處理 ${records.length} 筆新記錄`, {
        module: "peopleCountingMonitor",
        triggerSource,
      });
    }

    logger.debug("人流統計監控: 更新 lastCheckTime 完成", {
      module: "peopleCountingMonitor",
      triggerSource,
      newLastCheckTime: lastCheckTime.toISOString(),
    });
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

