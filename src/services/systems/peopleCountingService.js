/**
 * 人流統計地點管理服務
 *
 * 使用統一地點管理架構，location_type = 'people_counting'
 */

const locationService = require("./locationService");
const externalDb = require("../../database/externalDb");
const logger = require("../../utils/logger");

// ========== 地點管理 API ==========

/**
 * 取得人流統計地點列表
 */
async function getPeopleCountingLocations(options = {}) {
  try {
    const { floorId } = options;

    // 使用統一服務，篩選 people_counting 類型
    const result = await locationService.getFloors({
      locationType: "people_counting",
    });

    // 如果指定了 floorId，只返回該樓層的地點
    if (floorId) {
      const floor = result.floors.find((f) => String(f.id) === String(floorId));
      if (floor) {
        return {
          locations: floor.locations || [],
        };
      }
      return { locations: [] };
    }

    // 返回所有地點（扁平化）
    const allLocations = result.floors.flatMap(
      (floor) => floor.locations || []
    );
    return {
      locations: allLocations,
    };
  } catch (error) {
    logger.error("取得人流統計地點列表失敗", {
      error,
      module: "peopleCountingService",
    });
    throw new Error("取得人流統計地點列表失敗: " + error.message);
  }
}

/**
 * 取得單一地點
 */
async function getPeopleCountingLocationById(id) {
  try {
    // 先取得地點
    const location = await locationService.getLocationById(id);

    // 驗證地點類型
    if (location.locationType !== "people_counting") {
      const error = new Error("地點類型不正確");
      error.statusCode = 400;
      throw error;
    }

    return { location };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    logger.error("取得人流統計地點失敗", {
      error,
      id,
      module: "peopleCountingService",
    });
    throw new Error("取得人流統計地點失敗: " + error.message);
  }
}

/**
 * 建立人流統計地點
 */
async function createPeopleCountingLocation(locationData, userId) {
  try {
    const {
      name,
      floorId,
      personGroupIds = [],
      entryDoorId,
      exitDoorId,
    } = locationData;

    // 驗證必填欄位
    if (!name || name.trim().length === 0) {
      const error = new Error("地點名稱不能為空");
      error.statusCode = 400;
      throw error;
    }

    if (!floorId) {
      const error = new Error("樓層 ID 不能為空");
      error.statusCode = 400;
      throw error;
    }

    if (!Array.isArray(personGroupIds) || personGroupIds.length === 0) {
      const error = new Error("至少需要選擇一個進場單位");
      error.statusCode = 400;
      throw error;
    }

    if (!entryDoorId) {
      const error = new Error("入口設備 ID 不能為空");
      error.statusCode = 400;
      throw error;
    }

    if (!exitDoorId) {
      const error = new Error("出口設備 ID 不能為空");
      error.statusCode = 400;
      throw error;
    }

    if (entryDoorId === exitDoorId) {
      const error = new Error("入口和出口不能是同一個設備");
      error.statusCode = 400;
      throw error;
    }

    // 使用統一服務建立地點（傳入正確的配置格式）
    const result = await locationService.createLocation(
      {
        floorId: parseInt(floorId),
        name: name.trim(),
        locationType: "people_counting",
        config: {
          personGroupIds,
          entryDoorId,
          exitDoorId,
        },
      },
      userId
    );

    return {
      message: "人流統計地點建立成功",
      location: result.location,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    logger.error("建立人流統計地點失敗", {
      error,
      module: "peopleCountingService",
    });
    throw new Error("建立人流統計地點失敗: " + error.message);
  }
}

/**
 * 更新人流統計地點
 */
async function updatePeopleCountingLocation(id, locationData, userId) {
  try {
    const { name, personGroupIds, entryDoorId, exitDoorId } = locationData;

    // 驗證地點是否存在且類型正確
    const existing = await getPeopleCountingLocationById(id);

    // 建立更新配置
    const updates = {};
    if (name !== undefined) {
      if (!name || name.trim().length === 0) {
        const error = new Error("地點名稱不能為空");
        error.statusCode = 400;
        throw error;
      }
      updates.name = name.trim();
    }

    if (personGroupIds !== undefined) {
      if (!Array.isArray(personGroupIds) || personGroupIds.length === 0) {
        const error = new Error("至少需要選擇一個進場單位");
        error.statusCode = 400;
        throw error;
      }
    }

    // 檢查入口和出口是否相同
    if (entryDoorId !== undefined || exitDoorId !== undefined) {
      const currentEntry = existing.location.entryDoorId;
      const currentExit = existing.location.exitDoorId;
      const newEntry = entryDoorId !== undefined ? entryDoorId : currentEntry;
      const newExit = exitDoorId !== undefined ? exitDoorId : currentExit;

      if (newEntry && newExit && newEntry === newExit) {
        const error = new Error("入口和出口不能是同一個設備");
        error.statusCode = 400;
        throw error;
      }
    }

    // 建立配置物件（合併現有配置）
    const currentConfig = {
      person_group_ids: existing.location.personGroupIds || [],
      entry_door_id: existing.location.entryDoorId || null,
      exit_door_id: existing.location.exitDoorId || null,
    };

    const config = {
      ...currentConfig,
      ...(personGroupIds !== undefined && { person_group_ids: personGroupIds }),
      ...(entryDoorId !== undefined && { entry_door_id: entryDoorId }),
      ...(exitDoorId !== undefined && { exit_door_id: exitDoorId }),
    };

    // 使用統一服務更新地點（傳入正確的格式）
    const updateData = {
      ...(updates.name && { name: updates.name }),
      config: {
        personGroupIds: config.person_group_ids,
        entryDoorId: config.entry_door_id,
        exitDoorId: config.exit_door_id,
      },
    };

    const result = await locationService.updateLocation(id, updateData, userId);

    return {
      message: "人流統計地點更新成功",
      location: result.location,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    logger.error("更新人流統計地點失敗", {
      error,
      id,
      module: "peopleCountingService",
    });
    throw new Error("更新人流統計地點失敗: " + error.message);
  }
}

/**
 * 刪除人流統計地點
 */
async function deletePeopleCountingLocation(id) {
  try {
    // 驗證地點是否存在且類型正確
    await getPeopleCountingLocationById(id);

    // 使用統一服務刪除地點
    return await locationService.deleteLocation(id);
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    logger.error("刪除人流統計地點失敗", {
      error,
      id,
      module: "peopleCountingService",
    });
    throw new Error("刪除人流統計地點失敗: " + error.message);
  }
}

// ========== 業務邏輯 API ==========

/**
 * 生成刷卡記錄的唯一 ID
 * @param {number} personId - 人員 ID
 * @param {string} timestamp - 時間戳記
 * @returns {string} 唯一 ID
 */
function generateRecordId(personId, timestamp) {
  const timestampNum = new Date(timestamp).getTime();
  return `${personId}-${timestampNum}`;
}

/**
 * 判斷事件類型（entry/exit）
 * 基於時間序列和人員在場狀態
 * @param {Object} record - 當前記錄
 * @param {Array} allRecords - 所有記錄（已按時間排序）
 * @param {number} recordIndex - 當前記錄索引
 * @param {Map} personPresenceMap - 人員在場狀態映射
 * @returns {string} "entry" 或 "exit"
 */
function parseEventType(record, allRecords, recordIndex, personPresenceMap) {
  const personId = record.person_id;
  const recordTime = new Date(record.swip_card_rev_time);

  // 未註冊人員預設為 entry
  if (personId === -1) {
    return "entry";
  }

  const previousPresence = personPresenceMap.get(personId);

  if (!previousPresence) {
    // 第一次記錄，預設為 entry
    personPresenceMap.set(personId, {
      lastEvent: "entry",
      lastTime: recordTime,
    });
    return "entry";
  }

  // 計算時間間隔
  const timeDiff = recordTime.getTime() - previousPresence.lastTime.getTime();
  const SHORT_INTERVAL = 5 * 60 * 1000; // 5 分鐘
  const LONG_INTERVAL = 30 * 60 * 1000; // 30 分鐘

  // 判斷邏輯：
  // 1. 如果前一次是 entry 且時間間隔很短，這次應該是 exit
  // 2. 如果前一次是 exit 且時間間隔很長，這次應該是 entry
  // 3. 其他情況，取相反類型

  let eventType;
  if (previousPresence.lastEvent === "entry" && timeDiff < SHORT_INTERVAL) {
    eventType = "exit";
  } else if (
    previousPresence.lastEvent === "exit" &&
    timeDiff > LONG_INTERVAL
  ) {
    eventType = "entry";
  } else {
    eventType = previousPresence.lastEvent === "entry" ? "exit" : "entry";
  }

  personPresenceMap.set(personId, {
    lastEvent: eventType,
    lastTime: recordTime,
  });

  return eventType;
}

/**
 * 取得所有工地列表（含統計）
 * @returns {Promise<Object>} 工地列表
 */
async function getSites() {
  try {
    // 1. 取得所有地點（工地）
    const locationsResult = await locationService.getFloors({
      locationType: "people_counting",
    });

    const sites = [];
    const allLocations = (locationsResult.floors || []).flatMap(
      (floor) => floor.locations || []
    );

    if (allLocations.length === 0) {
      return { sites: [] };
    }

    // 2. 批次取得所有工地的人員 ID 和記錄
    const siteDataMap = await batchGetSitesData(allLocations);

    // 3. 為每個地點計算統計
    for (const location of allLocations) {
      const personGroupIds = location.personGroupIds || [];

      if (personGroupIds.length === 0) {
        continue;
      }

      const siteData = siteDataMap.get(location.id);
      if (!siteData) {
        continue;
      }

      // 計算統計
      const stats = calculateTodayStats(siteData.records);

      // 取得單位列表
      const units = await getUnitsByGroupIds(personGroupIds, siteData.records);

      sites.push({
        id: location.id,
        name: location.name,
        entryCount: stats.entryCount,
        exitCount: stats.exitCount,
        units: units,
      });
    }

    return { sites };
  } catch (error) {
    logger.error("取得工地列表失敗", {
      error,
      module: "peopleCountingService",
    });
    throw new Error("取得工地列表失敗: " + error.message);
  }
}

/**
 * 取得工地統計
 * @param {number} siteId - 工地 ID
 * @returns {Promise<Object>} 統計資料
 */
async function getSiteStats(siteId) {
  try {
    // 取得地點資訊
    const locationResult = await getPeopleCountingLocationById(siteId);
    const location = locationResult.location;
    const personGroupIds = location.personGroupIds || [];

    if (personGroupIds.length === 0) {
      return {
        entryCount: 0,
        exitCount: 0,
        currentCount: 0,
      };
    }

    // 取得該工地所有人員的 person_id
    const personIds = await getPersonIdsByGroupIds(personGroupIds);

    if (personIds.length === 0) {
      return {
        entryCount: 0,
        exitCount: 0,
        currentCount: 0,
      };
    }

    // 取得今日所有刷卡記錄
    const todayRecords = await getTodayRecords(personIds);

    // 計算統計
    const stats = calculateTodayStats(todayRecords);

    // 計算當前在場人數
    const currentCount = calculateCurrentCount(todayRecords);

    return {
      entryCount: stats.entryCount,
      exitCount: stats.exitCount,
      currentCount: currentCount,
    };
  } catch (error) {
    logger.error("取得工地統計失敗", {
      error,
      siteId,
      module: "peopleCountingService",
    });
    throw new Error("取得工地統計失敗: " + error.message);
  }
}

/**
 * 取得工地進出場記錄（含資料關聯和事件類型判斷）
 * @param {number} siteId - 工地 ID
 * @param {Object} options - 選項
 * @param {number} options.limit - 限制筆數
 * @param {number} options.unitId - 單位 ID（可選）
 * @returns {Promise<Object>} 記錄列表
 */
async function getSiteLogs(siteId, options = {}) {
  try {
    const { limit = 50, unitId } = options;

    // 取得地點資訊
    const locationResult = await getPeopleCountingLocationById(siteId);
    const location = locationResult.location;
    let personGroupIds = location.personGroupIds || [];

    // 如果指定了單位 ID，只查詢該單位
    if (unitId) {
      personGroupIds = [unitId];
    }

    if (personGroupIds.length === 0) {
      return { logs: [] };
    }

    // 取得該工地所有人員的 person_id
    const personIds = await getPersonIdsByGroupIds(personGroupIds);

    if (personIds.length === 0) {
      return { logs: [] };
    }

    // 取得刷卡記錄（使用 JOIN 查詢關聯 person 和 person_group）
    const records = await getRecordsWithJoin(personIds, limit);

    // 判斷事件類型
    const personPresenceMap = new Map();
    const sortedRecords = sortRecordsByTime(records);

    const logs = sortedRecords.map((record, index) => {
      const eventType = parseEventType(
        record,
        sortedRecords,
        index,
        personPresenceMap
      );

      return {
        id: generateRecordId(record.person_id, record.swip_card_rev_time),
        personId: record.person_id,
        personName: record.person_name || "未註冊人員",
        unitId: record.unit_id || null,
        unitName: record.unit_name || "",
        eventType: eventType,
        timestamp: record.swip_card_rev_time,
        deviceScreenshotUrl: record.snap_pic_url || "",
      };
    });

    return { logs };
  } catch (error) {
    logger.error("取得工地進出場記錄失敗", {
      error,
      siteId,
      options,
      module: "peopleCountingService",
    });
    throw new Error("取得工地進出場記錄失敗: " + error.message);
  }
}

/**
 * 取得單位人員列表（含狀態計算）
 * @param {number} unitId - 單位 ID
 * @returns {Promise<Object>} 人員列表
 */
async function getUnitPersonnel(unitId) {
  try {
    // 取得該單位的人員（優化：直接使用 SQL 查詢）
    const sql = `
      SELECT id, person_group_id, person_type, full_name
      FROM platform.person
      WHERE person_group_id = $1
        AND person_type = 0
      ORDER BY id ASC
    `;

    const persons = await externalDb.query(sql, [unitId]);

    if (!persons || persons.length === 0) {
      return { personnel: [] };
    }

    const personIds = persons.map((p) => p.id);

    // 批次取得人員照片（優化：使用 SQL 查詢）
    const headPicMap = await batchGetHeadPics(personIds);

    // 取得該單位人員的刷卡記錄（優化：直接在 SQL 中過濾）
    const allRecords = await getRecordsByPersonIds(personIds);

    // 計算每個人員的狀態
    const sortedRecords = sortRecordsByTime(allRecords);

    const personRecords = new Map();
    const personPresenceMap = new Map();

    sortedRecords.forEach((record, index) => {
      const personId = record.person_id;
      if (personId === -1) return;

      const eventType = parseEventType(
        record,
        sortedRecords,
        index,
        personPresenceMap
      );

      if (!personRecords.has(personId)) {
        personRecords.set(personId, {
          lastEntry: null,
          lastExit: null,
        });
      }

      const personRecord = personRecords.get(personId);
      if (eventType === "entry") {
        if (
          !personRecord.lastEntry ||
          new Date(record.swip_card_rev_time) >
            new Date(personRecord.lastEntry.swip_card_rev_time)
        ) {
          personRecord.lastEntry = record;
        }
      } else {
        if (
          !personRecord.lastExit ||
          new Date(record.swip_card_rev_time) >
            new Date(personRecord.lastExit.swip_card_rev_time)
        ) {
          personRecord.lastExit = record;
        }
      }
    });

    // 建立人員列表
    const personnel = persons.map((person) => {
      const headPic = headPicMap.get(person.id);
      const record = personRecords.get(person.id);

      let photoUrl = undefined;
      if (headPic?.standard_head_portrait) {
        photoUrl = headPic.standard_head_portrait;
      } else if (headPic?.thumbnail_head_portrait) {
        photoUrl = headPic.thumbnail_head_portrait;
      }

      // 判斷是否在場內
      let isInside = false;
      if (record?.lastEntry) {
        if (!record.lastExit) {
          isInside = true;
        } else {
          const entryTime = new Date(record.lastEntry.swip_card_rev_time);
          const exitTime = new Date(record.lastExit.swip_card_rev_time);
          isInside = entryTime > exitTime;
        }
      }

      return {
        id: person.id,
        employeeId: String(person.id),
        name: person.full_name || "",
        photoUrl: photoUrl,
        isInside: isInside,
        lastEntryTime: record?.lastEntry
          ? record.lastEntry.swip_card_rev_time
          : null,
        lastExitTime: record?.lastExit
          ? record.lastExit.swip_card_rev_time
          : null,
      };
    });

    return { personnel };
  } catch (error) {
    logger.error("取得單位人員列表失敗", {
      error,
      unitId,
      module: "peopleCountingService",
    });
    throw new Error("取得單位人員列表失敗: " + error.message);
  }
}

// ========== 輔助函數 ==========

/**
 * 根據群組 ID 取得人員 ID 列表（優化：使用單一 SQL 查詢）
 * @param {Array<number>} groupIds - 群組 ID 列表
 * @returns {Promise<Array<number>>} 人員 ID 列表
 */
async function getPersonIdsByGroupIds(groupIds) {
  if (groupIds.length === 0) {
    return [];
  }

  // 使用單一 SQL 查詢取代多個 API 呼叫
  const placeholders = groupIds.map((_, index) => `$${index + 1}`).join(", ");
  const sql = `
    SELECT DISTINCT id
    FROM platform.person
    WHERE person_group_id IN (${placeholders})
      AND person_type = 0
  `;

  try {
    const rows = await externalDb.query(sql, groupIds);
    return rows.map((row) => row.id);
  } catch (error) {
    logger.warn("無法取得群組的人員", {
      error,
      groupIds,
      module: "peopleCountingService",
    });
    return [];
  }
}

/**
 * 取得今日刷卡記錄（優化：直接在 SQL 中過濾）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @returns {Promise<Array>} 記錄列表
 */
async function getTodayRecords(personIds) {
  if (personIds.length === 0) {
    return [];
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // 使用 SQL 直接查詢，避免取得所有記錄後再過濾
  const placeholders = personIds.map((_, index) => `$${index + 1}`).join(", ");
  const sql = `
    SELECT *
    FROM baseacs.slot_card_records
    WHERE person_id IN (${placeholders})
      AND person_id != -1
      AND swip_card_rev_time >= $${personIds.length + 1}
      AND swip_card_rev_time < $${personIds.length + 2}
    ORDER BY swip_card_rev_time ASC
  `;

  const params = [...personIds, today.toISOString(), tomorrow.toISOString()];

  try {
    const rows = await externalDb.query(sql, params);
    return rows;
  } catch (error) {
    logger.warn("無法取得今日刷卡記錄", {
      error,
      personIds,
      module: "peopleCountingService",
    });
    return [];
  }
}

/**
 * 取得指定人員的刷卡記錄（優化：直接在 SQL 中過濾）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @param {number} limit - 限制筆數（可選）
 * @returns {Promise<Array>} 記錄列表
 */
async function getRecordsByPersonIds(personIds, limit = null) {
  if (personIds.length === 0) {
    return [];
  }

  const placeholders = personIds.map((_, index) => `$${index + 1}`).join(", ");
  let sql = `
    SELECT *
    FROM baseacs.slot_card_records
    WHERE person_id IN (${placeholders})
      AND person_id != -1
    ORDER BY swip_card_rev_time DESC
  `;

  const params = [...personIds];
  if (limit) {
    sql += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  try {
    const rows = await externalDb.query(sql, params);
    return rows;
  } catch (error) {
    logger.warn("無法取得人員的刷卡記錄", {
      error,
      personIds,
      module: "peopleCountingService",
    });
    return [];
  }
}

/**
 * 批次取得人員照片（優化：使用 SQL 查詢）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @returns {Promise<Map<number, Object>>} 人員 ID -> 照片資料的映射
 */
async function batchGetHeadPics(personIds) {
  if (personIds.length === 0) {
    return new Map();
  }

  // 使用 SQL 查詢取得每個人的最新照片（使用 DISTINCT ON）
  const placeholders = personIds.map((_, index) => `$${index + 1}`).join(", ");
  const sql = `
    SELECT DISTINCT ON (person_id)
      person_id,
      standard_head_portrait,
      thumbnail_head_portrait
    FROM platform.person_head_pic
    WHERE person_id IN (${placeholders})
    ORDER BY person_id, id DESC
  `;

  try {
    const rows = await externalDb.query(sql, personIds);
    const headPicMap = new Map();
    rows.forEach((row) => {
      headPicMap.set(row.person_id, row);
    });
    return headPicMap;
  } catch (error) {
    logger.warn("無法批次取得人員照片", {
      error,
      personIds,
      module: "peopleCountingService",
    });
    return new Map();
  }
}

/**
 * 使用 JOIN 查詢取得記錄（含關聯資料）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @param {number} limit - 限制筆數
 * @returns {Promise<Array>} 記錄列表
 */
async function getRecordsWithJoin(personIds, limit) {
  if (personIds.length === 0) {
    return [];
  }

  const placeholders = personIds.map((_, index) => `$${index + 1}`).join(", ");

  const sql = `
    SELECT 
      r.person_id,
      r.swip_card_rev_time,
      r.snap_pic_url,
      p.full_name AS person_name,
      p.person_group_id AS unit_id,
      pg.name AS unit_name
    FROM baseacs.slot_card_records r
    LEFT JOIN platform.person p ON r.person_id = p.id
    LEFT JOIN platform.person_group pg ON p.person_group_id = pg.id
    WHERE r.person_id IN (${placeholders})
      AND r.person_id != -1
    ORDER BY r.swip_card_rev_time DESC
    LIMIT $${personIds.length + 1}
  `;

  const params = [...personIds, limit];

  try {
    const rows = await externalDb.query(sql, params);
    return rows;
  } catch (error) {
    logger.error("JOIN 查詢失敗", {
      error,
      personIds,
      limit,
      module: "peopleCountingService",
    });
    throw error;
  }
}

/**
 * 排序記錄（按時間升序）
 * @param {Array} records - 記錄列表
 * @returns {Array} 排序後的記錄列表
 */
function sortRecordsByTime(records) {
  return [...records].sort(
    (a, b) =>
      new Date(a.swip_card_rev_time).getTime() -
      new Date(b.swip_card_rev_time).getTime()
  );
}

/**
 * 計算今日統計（進場/出場人數）
 * @param {Array} records - 記錄列表
 * @returns {Object} 統計資料
 */
function calculateTodayStats(records) {
  if (records.length === 0) {
    return { entryCount: 0, exitCount: 0 };
  }

  const personPresenceMap = new Map();
  let entryCount = 0;
  let exitCount = 0;

  const sortedRecords = sortRecordsByTime(records);

  sortedRecords.forEach((record, index) => {
    const eventType = parseEventType(
      record,
      sortedRecords,
      index,
      personPresenceMap
    );

    if (eventType === "entry") {
      entryCount++;
    } else {
      exitCount++;
    }
  });

  return { entryCount, exitCount };
}

/**
 * 計算當前在場人數
 * @param {Array} records - 記錄列表
 * @returns {number} 當前在場人數
 */
function calculateCurrentCount(records) {
  if (records.length === 0) {
    return 0;
  }

  const personPresenceMap = new Map();
  const personStatus = new Map();

  const sortedRecords = sortRecordsByTime(records);

  sortedRecords.forEach((record, index) => {
    const personId = record.person_id;
    if (personId === -1) return;

    const eventType = parseEventType(
      record,
      sortedRecords,
      index,
      personPresenceMap
    );
    const recordTime = new Date(record.swip_card_rev_time);

    const current = personStatus.get(personId);
    if (!current || recordTime > current.lastTime) {
      personStatus.set(personId, {
        lastEvent: eventType,
        lastTime: recordTime,
      });
    }
  });

  // 計算最後事件為 entry 的人數
  let count = 0;
  personStatus.forEach((status) => {
    if (status.lastEvent === "entry") {
      count++;
    }
  });

  return count;
}

/**
 * 批次取得所有群組資訊（優化：使用單一 SQL 查詢）
 * @param {Array<number>} groupIds - 群組 ID 列表
 * @returns {Promise<Map<number, Object>>} 群組映射表
 */
async function batchGetGroups(groupIds) {
  if (groupIds.length === 0) {
    return new Map();
  }

  const placeholders = groupIds.map((_, index) => `$${index + 1}`).join(", ");
  const sql = `
    SELECT id, name
    FROM platform.person_group
    WHERE id IN (${placeholders})
      AND is_deleted = 0
  `;

  try {
    const rows = await externalDb.query(sql, groupIds);
    const groupMap = new Map();
    rows.forEach((row) => {
      groupMap.set(row.id, row);
    });
    return groupMap;
  } catch (error) {
    logger.warn("無法取得群組資訊", {
      error,
      groupIds,
      module: "peopleCountingService",
    });
    return new Map();
  }
}

/**
 * 批次取得群組的人員 ID（優化：使用單一 SQL 查詢）
 * @param {Array<number>} groupIds - 群組 ID 列表
 * @returns {Promise<Map<number, Array<number>>>} 群組 ID -> 人員 ID 列表的映射
 */
async function batchGetGroupPersonIds(groupIds) {
  if (groupIds.length === 0) {
    return new Map();
  }

  const placeholders = groupIds.map((_, index) => `$${index + 1}`).join(", ");
  const sql = `
    SELECT person_group_id, id
    FROM platform.person
    WHERE person_group_id IN (${placeholders})
      AND person_type = 0
  `;

  try {
    const rows = await externalDb.query(sql, groupIds);
    const groupPersonMap = new Map();
    groupIds.forEach((groupId) => {
      groupPersonMap.set(groupId, []);
    });
    rows.forEach((row) => {
      const personIds = groupPersonMap.get(row.person_group_id) || [];
      personIds.push(row.id);
      groupPersonMap.set(row.person_group_id, personIds);
    });
    return groupPersonMap;
  } catch (error) {
    logger.warn("無法取得群組的人員 ID", {
      error,
      groupIds,
      module: "peopleCountingService",
    });
    return new Map();
  }
}

/**
 * 批次取得工地資料（優化：減少查詢次數）
 * @param {Array} locations - 地點列表
 * @returns {Promise<Map<number, Object>>} 工地 ID -> 資料的映射
 */
async function batchGetSitesData(locations) {
  const siteDataMap = new Map();

  // 收集所有群組 ID
  const allGroupIds = new Set();
  const siteGroupMap = new Map(); // siteId -> groupIds

  locations.forEach((location) => {
    const personGroupIds = location.personGroupIds || [];
    if (personGroupIds.length > 0) {
      siteGroupMap.set(location.id, personGroupIds);
      personGroupIds.forEach((id) => allGroupIds.add(id));
    }
  });

  if (allGroupIds.size === 0) {
    return siteDataMap;
  }

  // 批次取得所有群組的人員 ID
  const groupPersonMap = await batchGetGroupPersonIds(Array.from(allGroupIds));

  // 收集所有人員 ID
  const allPersonIds = new Set();
  groupPersonMap.forEach((personIds) => {
    personIds.forEach((id) => allPersonIds.add(id));
  });

  if (allPersonIds.size === 0) {
    return siteDataMap;
  }

  // 批次取得今日所有記錄
  const todayRecords = await getTodayRecords(Array.from(allPersonIds));

  // 為每個工地建立資料
  siteGroupMap.forEach((groupIds, siteId) => {
    const sitePersonIds = new Set();
    groupIds.forEach((groupId) => {
      const personIds = groupPersonMap.get(groupId) || [];
      personIds.forEach((id) => sitePersonIds.add(id));
    });

    const siteRecords = todayRecords.filter(
      (r) => r.person_id !== -1 && sitePersonIds.has(r.person_id)
    );

    siteDataMap.set(siteId, {
      personIds: Array.from(sitePersonIds),
      records: siteRecords,
    });
  });

  return siteDataMap;
}

/**
 * 根據群組 ID 取得單位列表（含統計）
 * @param {Array<number>} groupIds - 群組 ID 列表
 * @param {Array} records - 記錄列表
 * @returns {Promise<Array>} 單位列表
 */
async function getUnitsByGroupIds(groupIds, records) {
  if (groupIds.length === 0) {
    return [];
  }

  // 批次取得群組資訊
  const groupMap = await batchGetGroups(groupIds);
  // 批次取得群組的人員 ID
  const groupPersonMap = await batchGetGroupPersonIds(groupIds);

  const units = [];

  groupIds.forEach((groupId) => {
    const group = groupMap.get(groupId);
    if (!group) {
      return;
    }

    const unitPersonIds = groupPersonMap.get(groupId) || [];

    // 過濾該單位的記錄
    const unitRecords = records.filter(
      (r) => r.person_id !== -1 && unitPersonIds.includes(r.person_id)
    );

    // 計算當前在場人數
    const currentCount = calculateCurrentCount(unitRecords);

    units.push({
      id: group.id,
      name: group.name,
      currentCount: currentCount,
      totalCount: unitPersonIds.length,
    });
  });

  return units;
}

module.exports = {
  getPeopleCountingLocations,
  getPeopleCountingLocationById,
  createPeopleCountingLocation,
  updatePeopleCountingLocation,
  deletePeopleCountingLocation,
  // 新增的業務邏輯 API
  getSites,
  getSiteStats,
  getSiteLogs,
  getUnitPersonnel,
};
