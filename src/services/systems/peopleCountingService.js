/**
 * 人流統計地點管理服務
 * 
 * 使用統一地點管理架構，location_type = 'people_counting'
 */

const locationService = require("./locationService");
const externalDb = require("../../database/externalDb");
const logger = require("../../utils/logger");

// ========== 統一錯誤處理和驗證工具 ==========

/**
 * 創建驗證錯誤
 * @param {string} message - 錯誤訊息
 * @returns {Error} 帶有 statusCode 的錯誤對象
 */
function createValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/**
 * 統一錯誤處理包裝器
 * 用於業務邏輯錯誤（關鍵錯誤，需要拋出）
 * @param {Function} fn - 異步函數
 * @param {string} errorMessage - 錯誤訊息前綴
 * @param {Object} context - 上下文信息
 * @returns {Promise} 函數執行結果
 */
async function handleServiceError(fn, errorMessage, context = {}) {
  try {
    return await fn();
  } catch (error) {
    // 如果錯誤已經有 statusCode（驗證錯誤等），直接拋出
    if (error.statusCode) {
      throw error;
    }
    logger.error(errorMessage, {
      error,
      ...context,
      module: "peopleCountingService",
    });
    throw new Error(errorMessage + ": " + error.message);
  }
}

/**
 * 統一非關鍵錯誤處理（降級處理）
 * 用於非關鍵錯誤（可返回預設值）
 * @param {Function} fn - 異步函數
 * @param {string} warnMessage - 警告訊息
 * @param {*} defaultValue - 預設返回值
 * @param {Object} context - 上下文信息
 * @returns {Promise} 函數執行結果或預設值
 */
async function handleNonCriticalError(fn, warnMessage, defaultValue, context = {}) {
  try {
    return await fn();
  } catch (error) {
    logger.warn(warnMessage, {
      error,
      ...context,
      module: "peopleCountingService",
    });
    return defaultValue;
  }
}

/**
 * 驗證地點資料
 * @param {Object} locationData - 地點資料
 * @param {boolean} isUpdate - 是否為更新操作
 * @throws {Error} 驗證失敗時拋出錯誤
 */
function validateLocationData(locationData, isUpdate = false) {
  const { name, zoneId, personGroupIds, entryDoorId, exitDoorId } = locationData;

  // 建立時驗證必填欄位
  if (!isUpdate) {
    if (!name?.trim()) {
      throw createValidationError("地點名稱不能為空");
    }
    if (!zoneId) {
      throw createValidationError("區域 ID 不能為空");
    }
    if (!Array.isArray(personGroupIds) || personGroupIds.length === 0) {
      throw createValidationError("至少需要選擇一個進場單位");
    }
    if (!entryDoorId) {
      throw createValidationError("入口設備 ID 不能為空");
    }
    if (!exitDoorId) {
      throw createValidationError("出口設備 ID 不能為空");
    }
  }

  // 更新時驗證提供的欄位
  if (isUpdate) {
    if (name !== undefined && !name?.trim()) {
      throw createValidationError("地點名稱不能為空");
    }
    if (personGroupIds !== undefined && (!Array.isArray(personGroupIds) || personGroupIds.length === 0)) {
      throw createValidationError("至少需要選擇一個進場單位");
    }
  }

  // 驗證入口和出口不能相同
  const finalEntry = entryDoorId !== undefined ? entryDoorId : (locationData.currentEntry || null);
  const finalExit = exitDoorId !== undefined ? exitDoorId : (locationData.currentExit || null);
  if (finalEntry && finalExit && finalEntry === finalExit) {
    throw createValidationError("入口和出口不能是同一個設備");
  }
}

/**
 * 確保陣列值
 * @param {*} value - 值
 * @returns {Array} 陣列
 */
function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

// ========== 地點管理 API ==========

/**
 * 取得人流統計地點列表
 */
async function getPeopleCountingLocations(options = {}) {
  return handleServiceError(
    async () => {
    const { zoneId } = options;
    
    // 使用統一服務，篩選 people_counting 類型
    const result = await locationService.getZones({
      locationType: "people_counting",
    });
    const zones = result.zones;
    
    // 如果指定了 zoneId，只返回該區域的地點
    if (zoneId) {
      const zone = zones.find((z) => String(z.id) === String(zoneId));
      if (zone) {
        return {
            locations: ensureArray(zone.locations),
        };
      }
      return { locations: [] };
    }
    
    // 返回所有地點（扁平化）
    const allLocations = zones.flatMap(
        (zone) => ensureArray(zone.locations)
    );
    return {
      locations: allLocations,
    };
    },
    "取得人流統計地點列表失敗",
    { options }
  );
}

/**
 * 取得單一地點
 */
async function getPeopleCountingLocationById(id) {
  return handleServiceError(
    async () => {
    // 先取得地點
    const locationResult = await locationService.getLocationById(id);
    const location = locationResult.location;
    
    // 驗證地點類型：檢查 systems 中是否有 people_counting 系統
      const hasPeopleCountingSystem = ensureArray(location.systems).some(
      (sys) => sys.systemType === "people_counting"
    );
    
    if (!hasPeopleCountingSystem) {
        throw createValidationError("地點類型不正確");
    }
    
    return { location };
    },
    "取得人流統計地點失敗",
    { id }
  );
}

/**
 * 建立人流統計地點
 */
async function createPeopleCountingLocation(locationData, userId) {
  return handleServiceError(
    async () => {
    const {
      name,
      zoneId,
      personGroupIds = [],
      entryDoorId,
      exitDoorId,
    } = locationData;

      // 使用統一驗證函數
      validateLocationData(locationData, false);

    // 使用統一服務建立地點（傳入正確的配置格式）
    const result = await locationService.createLocation(
      {
        zoneId: parseInt(zoneId),
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
    },
    "建立人流統計地點失敗",
    { userId }
  );
}

/**
 * 更新人流統計地點
 */
async function updatePeopleCountingLocation(id, locationData, userId) {
  return handleServiceError(
    async () => {
    const { name, personGroupIds, entryDoorId, exitDoorId } = locationData;

    // 驗證地點是否存在且類型正確
    const existing = await getPeopleCountingLocationById(id);

      // 準備驗證資料（包含現有值）
      const validationData = {
        ...locationData,
        currentEntry: existing.location.entryDoorId,
        currentExit: existing.location.exitDoorId,
      };

      // 使用統一驗證函數
      validateLocationData(validationData, true);

    // 建立更新配置
    const updates = {};
    if (name !== undefined) {
      updates.name = name.trim();
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
    },
    "更新人流統計地點失敗",
    { id, userId }
  );
}

/**
 * 刪除人流統計地點
 */
async function deletePeopleCountingLocation(id) {
  return handleServiceError(
    async () => {
    // 驗證地點是否存在且類型正確
    await getPeopleCountingLocationById(id);

    // 使用統一服務刪除地點
    return await locationService.deleteLocation(id);
    },
    "刪除人流統計地點失敗",
    { id }
  );
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
 * 基於設備 physical_id（entryDoorId/exitDoorId）
 * @param {Object} record - 當前記錄
 * @param {number} entryDoorId - 入口設備 ID（對應 physical_id）
 * @param {number} exitDoorId - 出口設備 ID（對應 physical_id）
 * @returns {string} "entry" 或 "exit"
 */
function parseEventType(record, entryDoorId, exitDoorId) {
  // 未註冊人員視為失敗事件，不計入統計
  if (record.person_id === -1) {
    return null; // 返回 null 表示失敗事件
  }

  const physicalId = record.physical_id;

  // 如果 physical_id 等於 entryDoorId，則為 entry
  if (physicalId && entryDoorId && Number(physicalId) === Number(entryDoorId)) {
    return "entry";
  }

  // 如果 physical_id 等於 exitDoorId，則為 exit
  if (physicalId && exitDoorId && Number(physicalId) === Number(exitDoorId)) {
    return "exit";
  }
  return null;
}

/**
 * 取得所有工地列表（含統計）
 * @returns {Promise<Object>} 工地列表
 */
async function getSites() {
  return handleServiceError(
    async () => {
    // 1. 取得所有地點（工地）
    const locationsResult = await locationService.getZones({
      locationType: "people_counting",
    });

    const sites = [];
      const allLocations = ensureArray(locationsResult.zones).flatMap(
        (zone) => ensureArray(zone.locations)
    );

    if (allLocations.length === 0) {
      return { sites: [] };
    }

    // 2. 批次取得所有工地的人員 ID 和記錄
    const siteDataMap = await batchGetSitesData(allLocations);

    // 3. 為每個地點計算統計
    // 取得今日時間範圍（提取到循環外部，避免重複計算）
    const { start, end } = getTodayTimeRange();
    
    for (const location of allLocations) {
      const { personGroupIds, entryDoorId, exitDoorId } = getPeopleCountingConfig(location);

      if (personGroupIds.length === 0) {
        continue;
      }

      // 確保 ID 類型一致
      const locationId = normalizeId(location.id);
      const siteData = siteDataMap.get(locationId);
      if (!siteData) {
        continue;
      }

      // 取得今日記錄（用於統計）
      const todayRecords = siteData.records.filter((r) => {
        const recordTime = new Date(r.swip_card_rev_time);
        return recordTime >= start && recordTime <= end;
      });

      // 計算統計（使用 physical_id 判斷）
      const stats = calculateTodayStatsByPhysicalId(todayRecords, entryDoorId, exitDoorId);

      // 取得單位列表（傳入設備 ID）
      const units = await getUnitsByGroupIds(personGroupIds, siteData.records, entryDoorId, exitDoorId);

      sites.push({
        id: locationId,
        name: location.name,
        entryCount: stats.entryCount,
        exitCount: stats.exitCount,
        units: units,
      });
    }

    return { sites };
    },
    "取得工地列表失敗"
  );
}

/**
 * 取得工地統計
 * @param {number} siteId - 工地 ID
 * @returns {Promise<Object>} 統計資料
 */
async function getSiteStats(siteId) {
  return handleServiceError(
    async () => {
    // 取得工地配置（統一處理）
    const { personGroupIds, entryDoorId, exitDoorId } = await getSiteConfig(siteId);

      // 統一空值處理：返回預設統計值
    if (personGroupIds.length === 0) {
      return {
        entryCount: 0,
        exitCount: 0,
        currentCount: 0,
      };
    }

    // 取得該工地所有人員的 person_id
    const personIds = await getPersonIdsByGroupIds(personGroupIds);

      // 統一空值處理：返回預設統計值
    if (personIds.length === 0) {
      return {
        entryCount: 0,
        exitCount: 0,
        currentCount: 0,
      };
    }

    // 取得今日所有刷卡記錄（00:00 - 24:00）
    const todayRecords = await getTodayRecordsOnly(personIds);

    // 計算統計（使用 physical_id 判斷）
    const stats = calculateTodayStatsByPhysicalId(todayRecords, entryDoorId, exitDoorId);

    // 計算當前在場人數（使用 physical_id 判斷）
    const currentCount = calculateCurrentCount(todayRecords, entryDoorId, exitDoorId);

    return {
      entryCount: stats.entryCount,
      exitCount: stats.exitCount,
      currentCount: currentCount,
    };
    },
    "取得工地統計失敗",
    { siteId }
  );
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
  return handleServiceError(
    async () => {
    const { limit = 50, unitId } = options;

    // 取得工地配置（統一處理）
    const { entryDoorId, exitDoorId } = await getSiteConfig(siteId);

    const allowedPhysicalIds = [entryDoorId, exitDoorId]
      .filter((v) => v !== null && v !== undefined)
      .map((v) => Number(v))
      .filter((v) => !Number.isNaN(v));

    if (allowedPhysicalIds.length === 0) {
      return { logs: [] };
    }

    // 取得刷卡記錄（用 physical_id 查，才能包含未註冊人員 person_id = -1）
    // - 若有 unitId，仍可在 SQL 中篩選對應單位（person_group_id），未註冊人員會自然被排除
    const records = await getRecordsByPhysicalIdsWithJoin(allowedPhysicalIds, {
      limit,
      daysAgo: 2,
      unitId: unitId || null,
    });

    // 判斷事件類型
    // 按時間降序排序（最新的在最上方）
    const sortedRecords = [...records].sort(
      (a, b) =>
        new Date(b.swip_card_rev_time).getTime() -
        new Date(a.swip_card_rev_time).getTime()
    );

    const logs = sortedRecords.map((record) => {
      const eventType = parseEventType(record, entryDoorId, exitDoorId);

      return {
        id: generateRecordId(record.person_id, record.swip_card_rev_time),
        personId: record.person_id,
        personName: record.person_name || "未註冊人員",
        unitId: record.unit_id || null,
        unitName: record.unit_name || "",
        eventType: eventType || "failed", // 未註冊人員標記為 "failed"
        timestamp: record.swip_card_rev_time,
        deviceScreenshotUrl: record.snap_pic_url || "",
      };
    });

    return { logs };
    },
    "取得工地進出場記錄失敗",
    { siteId, options }
  );
}

/**
 * 依 physical_id 取得記錄（含關聯資料）
 * - 可包含未註冊人員（person_id = -1）
 * - 可選擇以 unitId（person_group_id）做篩選
 */
async function getRecordsByPhysicalIdsWithJoin(physicalIds, options = {}) {
  if (!Array.isArray(physicalIds) || physicalIds.length === 0) {
    return [];
  }

  const { limit = 50, daysAgo = 2, unitId = null } = options;
  const startTime = getDaysAgoStart(daysAgo);

  const placeholders = generatePlaceholders(physicalIds);
  const baseParamIndex = physicalIds.length + 1;

  const unitFilterSql = unitId ? `AND p.person_group_id = $${baseParamIndex + 1}` : "";
  const limitSql = limit ? `LIMIT $${baseParamIndex + (unitId ? 2 : 1)}` : "";

  const sql = `
    SELECT 
      r.person_id,
      r.swip_card_rev_time,
      r.snap_pic_url,
      r.physical_id,
      p.full_name AS person_name,
      p.person_group_id AS unit_id,
      pg.name AS unit_name
    FROM baseacs.slot_card_records r
    LEFT JOIN platform.person p ON r.person_id = p.id
    LEFT JOIN platform.person_group pg ON p.person_group_id = pg.id
    WHERE r.physical_id IN (${placeholders})
      AND r.is_deleted = false
      AND r.swip_card_rev_time >= $${baseParamIndex}
      ${unitFilterSql}
    ORDER BY r.swip_card_rev_time DESC
    ${limitSql}
  `;

  const params = [...physicalIds, startTime.toISOString()];
  if (unitId) {
    params.push(unitId);
  }
  if (limit) {
    params.push(limit);
  }

  return await externalDb.query(sql, params);
}

/**
 * 取得今日刷卡記錄（00:00:00 - 23:59:59.999）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @returns {Promise<Array>} 記錄列表
 */
async function getTodayRecordsOnly(personIds) {
  if (personIds.length === 0) {
    return [];
  }

  return handleNonCriticalError(
    async () => {
  const { start, end } = getTodayTimeRange();
  const placeholders = generatePlaceholders(personIds);
    const sql = `
    SELECT *
    FROM baseacs.slot_card_records
    WHERE person_id IN (${placeholders})
      AND person_id != -1
      AND is_deleted = false
      AND swip_card_rev_time >= $${personIds.length + 1}
      AND swip_card_rev_time <= $${personIds.length + 2}
    ORDER BY swip_card_rev_time ASC
    `;

  const params = [...personIds, start.toISOString(), end.toISOString()];
    const rows = await externalDb.query(sql, params);
    return rows;
    },
    "無法取得今日刷卡記錄",
    [],
    { personIds }
  );
}

/**
 * 計算今日統計（進場/出場人數，基於 physical_id）
 * 使用時間窗口去重：在同一個時間窗口內（預設1分鐘），同一人的相同事件類型只計算一次
 * @param {Array} records - 記錄列表（應該只包含今日記錄）
 * @param {number} entryDoorId - 入口設備 ID
 * @param {number} exitDoorId - 出口設備 ID
 * @param {number} dedupeWindowMinutes - 去重時間窗口（分鐘），預設1分鐘
 * @returns {Object} 統計資料
 */
function calculateTodayStatsByPhysicalId(records, entryDoorId, exitDoorId, dedupeWindowMinutes = 1) {
  if (records.length === 0) {
    return { entryCount: 0, exitCount: 0 };
  }

  // 按時間排序
  const sortedRecords = sortRecordsByTime(records);

  // 使用 Map 追蹤每個人在每個事件類型下的最後計數時間
  // Key: `${personId}_${eventType}`, Value: 最後計數的時間戳
  const lastCountedTime = new Map();
  const dedupeWindowMs = dedupeWindowMinutes * 60 * 1000;

  let entryCount = 0;
  let exitCount = 0;

  sortedRecords.forEach((record) => {
    const eventType = parseEventType(record, entryDoorId, exitDoorId);
      const personId = record.person_id;
    
    // 未註冊人員（eventType 為 null）跳過，不計入統計
    if (eventType === null) {
      return;
    }

    const recordTime = new Date(record.swip_card_rev_time).getTime();
    const key = `${personId}_${eventType}`;

    // 檢查是否在去重時間窗口內
    const lastTime = lastCountedTime.get(key);
    if (!lastTime || (recordTime - lastTime) >= dedupeWindowMs) {
      // 不在時間窗口內，計數並更新時間
      if (eventType === "entry") {
        entryCount++;
      } else {
        exitCount++;
      }
      lastCountedTime.set(key, recordTime);
    }
    // 在時間窗口內的記錄會被忽略（去重）
  });

  return { entryCount, exitCount };
}

/**
 * 取得所有人的最近進場記錄（不受時間限制）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @param {number} entryDoorId - 入口設備 ID
 * @param {number} exitDoorId - 出口設備 ID
 * @returns {Promise<Map<number, Object>>} 人員 ID -> 最近進場/出場記錄的映射
 */
async function getLatestEntryExitRecords(personIds, entryDoorId, exitDoorId) {
  if (personIds.length === 0) {
    return new Map();
  }

  const placeholders = generatePlaceholders(personIds);
  
  // 取得所有人的最近進場和出場記錄（不受時間限制）
  const sql = `
    SELECT 
      r.person_id,
      r.swip_card_rev_time,
      r.physical_id
    FROM baseacs.slot_card_records r
    WHERE r.person_id IN (${placeholders})
      AND r.person_id != -1
      AND r.is_deleted = false
    ORDER BY r.swip_card_rev_time DESC
  `;

  const allRecords = await externalDb.query(sql, personIds);
  
  // SQL 已經按時間降序排序，直接使用（不需要再次排序）
  const sortedRecords = allRecords;

  const personRecords = new Map();
  personIds.forEach((personId) => {
        personRecords.set(personId, {
          lastEntry: null,
          lastExit: null,
        });
  });

  // 找出每個人最近的一次進場和出場記錄
  // 因為已經按時間降序排序，所以第一次遇到的就是最新的
  sortedRecords.forEach((record) => {
    const personId = record.person_id;
    if (personId === -1) return;

    const eventType = parseEventType(record, entryDoorId, exitDoorId);
    // 跳過失敗事件（未註冊人員）
    if (eventType === null) return;

      const personRecord = personRecords.get(personId);

    if (eventType === "entry" && !personRecord.lastEntry) {
          personRecord.lastEntry = record;
    } else if (eventType === "exit" && !personRecord.lastExit) {
          personRecord.lastExit = record;
        }
  });

  return personRecords;
}

/**
 * 取得單位人員列表（含狀態計算和今日統計）
 * @param {number} unitId - 單位 ID
 * @param {number} siteId - 工地 ID（可選，用於取得入口/出口設備 ID）
 * @returns {Promise<Object>} 人員列表
 */
async function getUnitPersonnel(unitId, siteId = null) {
  return handleServiceError(
    async () => {
    let entryDoorId = null;
    let exitDoorId = null;

      // 如果提供了 siteId，從地點取得設備 ID（非關鍵錯誤，使用降級處理）
    if (siteId) {
        const config = await handleNonCriticalError(
          async () => await getSiteConfig(siteId),
          "無法取得工地配置，使用預設值",
          null,
          { siteId, unitId }
        );
        if (config) {
        entryDoorId = config.entryDoorId;
        exitDoorId = config.exitDoorId;
      }
    }
    // 取得該單位的人員（優化：直接使用 SQL 查詢）
    const sql = `
      SELECT id, person_group_id, person_type, full_name
      FROM platform.person
      WHERE person_group_id = $1
        AND person_type = 0
      ORDER BY id ASC
    `;

    const persons = await externalDb.query(sql, [unitId]);

      // 統一空值處理：返回空陣列和預設統計值
    if (!persons || persons.length === 0) {
      return { 
        personnel: [],
        entryCount: 0,
        exitCount: 0
      };
    }

    const personIds = persons.map((p) => p.id);

    // 批次取得人員照片（優化：使用 SQL 查詢）
    const headPicMap = await batchGetHeadPics(personIds);

    // 取得今日刷卡記錄（00:00 - 24:00，用於統計）
    const todayRecords = await getTodayRecordsOnly(personIds);

    // 計算今日進場/出場人數統計
    const todayStats = calculateTodayStatsByPhysicalId(todayRecords, entryDoorId, exitDoorId);

    // 取得所有人的最近進場/出場記錄（不受時間限制，用於顯示最近進場日期）
    const latestRecords = await getLatestEntryExitRecords(personIds, entryDoorId, exitDoorId);

    // 取得今日時間範圍（用於判斷是否為今日進場）
    const { start: todayStart, end: todayEnd } = getTodayTimeRange();

    // 建立人員列表
    const personnel = persons.map((person) => {
      const headPic = headPicMap.get(person.id);
      const latestRecord = latestRecords.get(person.id);

      let photoUrl = undefined;
      if (headPic?.standard_head_portrait) {
        photoUrl = headPic.standard_head_portrait;
      } else if (headPic?.thumbnail_head_portrait) {
        photoUrl = headPic.thumbnail_head_portrait;
      }

      // 最近進場記錄（不受時間限制）
      const lastEntryRecord = latestRecord?.lastEntry;
      const lastExitRecord = latestRecord?.lastExit;

      // 處理進場記錄
      let lastEntryDate = null;
      let lastEntryDateTime = null;
      let isTodayEntry = false;
      let entryTimeStr = null;
      let entryTime = null;

      if (lastEntryRecord) {
        entryTime = new Date(lastEntryRecord.swip_card_rev_time);
        lastEntryDateTime = lastEntryRecord.swip_card_rev_time;
        
        // 檢查是否為今日
        if (entryTime >= todayStart && entryTime <= todayEnd) {
          isTodayEntry = true;
        }
        
        // 格式化日期和時間
        lastEntryDate = formatDate(entryTime);
        entryTimeStr = formatTime(entryTime);
      }

      // 處理出場記錄
      let exitTimeStr = null;
      let exitTime = null;

      if (lastExitRecord) {
        exitTime = new Date(lastExitRecord.swip_card_rev_time);
        exitTimeStr = formatTime(exitTime);
      }

      // 判斷是否在場（isPresent）
      // 邏輯：如果沒有進場記錄，則不在場
      // 如果有進場記錄但沒有出場記錄，則在場
      // 如果有進場和出場記錄，則比較時間：如果出場時間 > 進場時間，則不在場；否則在場
      let isPresent = false;
      if (lastEntryRecord) {
        if (!lastExitRecord) {
          // 有進場但沒有出場，則在場
          isPresent = true;
        } else {
          // 有進場和出場，比較時間（使用已創建的 Date 對象）
          // 如果出場時間 > 進場時間，則不在場
          isPresent = exitTime <= entryTime;
        }
      }

      return {
        id: person.id,
        employeeId: String(person.id),
        name: person.full_name || "",
        photoUrl: photoUrl,
        isInside: isPresent, // 與 isPresent 保持一致（向後兼容）
        isPresent: isPresent,
        lastEntryTime: lastEntryDateTime,
        lastExitTime: lastExitRecord ? lastExitRecord.swip_card_rev_time : null,
        lastEntryDate: lastEntryDate,
        entryTime: entryTimeStr,
        exitTime: exitTimeStr,
        isTodayEntry: isTodayEntry,
      };
    });

    return { 
      personnel,
      entryCount: todayStats.entryCount,
      exitCount: todayStats.exitCount
    };
    },
    "取得單位人員列表失敗",
    { unitId, siteId }
  );
}

// ========== 輔助函數 ==========

/**
 * 格式化日期為 YYYY/MM/DD
 * @param {Date} date - 日期對象
 * @returns {string} 格式化後的日期字串
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

/**
 * 格式化時間為 HH:MM:SS
 * @param {Date} date - 日期對象
 * @returns {string} 格式化後的時間字串
 */
function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * 從地點取得人流統計系統配置
 * @param {Object} location - 地點物件
 * @returns {Object} { peopleCountingSystem, entryDoorId, exitDoorId, personGroupIds }
 */
function getPeopleCountingConfig(location) {
  const peopleCountingSystem = ensureArray(location.systems).find(
    (sys) => sys.systemType === "people_counting"
  );
  return {
    peopleCountingSystem,
    entryDoorId: peopleCountingSystem?.config?.entryDoorId || null,
    exitDoorId: peopleCountingSystem?.config?.exitDoorId || null,
    personGroupIds: ensureArray(peopleCountingSystem?.config?.personGroupIds),
  };
}

/**
 * 取得工地配置（統一處理地點取得和配置解析）
 * @param {number} siteId - 工地 ID
 * @returns {Promise<Object>} { location, personGroupIds, entryDoorId, exitDoorId }
 */
async function getSiteConfig(siteId) {
  const locationResult = await getPeopleCountingLocationById(siteId);
  const location = locationResult.location;
  const config = getPeopleCountingConfig(location);
  return {
    location,
    personGroupIds: config.personGroupIds,
    entryDoorId: config.entryDoorId,
    exitDoorId: config.exitDoorId,
  };
}

/**
 * 統一 ID 類型轉換（確保 ID 為數字）
 * @param {string|number} id - ID 值
 * @returns {number} 轉換後的數字 ID
 */
function normalizeId(id) {
  return typeof id === 'string' ? Number(id) : id;
}

/**
 * 時間範圍工具函數
 */

/**
 * 計算指定天數前的開始時間（00:00:00）
 * @param {number} daysAgo - 幾天前，預設為 0（今天）
 * @returns {Date} 指定天數前的日期時間
 */
function getDaysAgoStart(daysAgo = 0) {
  const now = new Date();
  const targetDate = new Date(now);
  targetDate.setDate(now.getDate() - daysAgo);
  targetDate.setHours(0, 0, 0, 0);
  return targetDate;
}

/**
 * 計算近兩天的開始時間（兩天前的 00:00:00）
 * @returns {Date} 兩天前的日期時間
 * @deprecated 使用 getDaysAgoStart(2) 替代
 */
function getTwoDaysAgo() {
  return getDaysAgoStart(2);
}

/**
 * 取得今日時間範圍（00:00:00 - 23:59:59.999）
 * @returns {Object} 包含 start 和 end 的時間範圍
 */
function getTodayTimeRange() {
  const start = getDaysAgoStart(0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * 根據群組 ID 取得人員 ID 列表（優化：使用單一 SQL 查詢）
 * @param {Array<number>} groupIds - 群組 ID 列表
 * @returns {Promise<Array<number>>} 人員 ID 列表
 */
async function getPersonIdsByGroupIds(groupIds) {
  if (groupIds.length === 0) {
    return [];
  }

  return handleNonCriticalError(
    async () => {
  // 使用單一 SQL 查詢取代多個 API 呼叫
  const placeholders = generatePlaceholders(groupIds);
  const sql = `
    SELECT DISTINCT id
    FROM platform.person
    WHERE person_group_id IN (${placeholders})
      AND person_type = 0
  `;

    const rows = await externalDb.query(sql, groupIds);
    return rows.map((row) => row.id);
    },
    "無法取得群組的人員",
    [],
    { groupIds }
  );
}

/**
 * 取得近兩天刷卡記錄（優化：直接在 SQL 中過濾）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @returns {Promise<Array>} 記錄列表
 */
async function getTodayRecords(personIds) {
  if (personIds.length === 0) {
    return [];
  }

  return handleNonCriticalError(
    async () => {
  // 使用 SQL 直接查詢，避免取得所有記錄後再過濾
  const placeholders = generatePlaceholders(personIds);
  const startTime = getDaysAgoStart(2);
  const sql = `
    SELECT *
    FROM baseacs.slot_card_records
    WHERE person_id IN (${placeholders})
      AND person_id != -1
      AND is_deleted = false
      AND swip_card_rev_time >= $${personIds.length + 1}
    ORDER BY swip_card_rev_time ASC
  `;

  const params = [...personIds, startTime.toISOString()];
    const rows = await externalDb.query(sql, params);
    return rows;
    },
    "無法取得近兩天刷卡記錄",
    [],
    { personIds }
  );
}

/**
 * 取得指定人員的近兩天刷卡記錄（優化：直接在 SQL 中過濾）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @param {number} limit - 限制筆數（可選）
 * @returns {Promise<Array>} 記錄列表
 */
async function getRecordsByPersonIds(personIds, limit = null) {
  if (personIds.length === 0) {
    return [];
  }

  return handleNonCriticalError(
    async () => {
  const placeholders = generatePlaceholders(personIds);
  const startTime = getDaysAgoStart(2);
  let sql = `
    SELECT *
    FROM baseacs.slot_card_records
    WHERE person_id IN (${placeholders})
      AND person_id != -1
      AND is_deleted = false
      AND swip_card_rev_time >= $${personIds.length + 1}
    ORDER BY swip_card_rev_time DESC
  `;

  const params = [...personIds, startTime.toISOString()];
  if (limit) {
    sql += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

    const rows = await externalDb.query(sql, params);
    return rows;
    },
    "無法取得人員的刷卡記錄",
    [],
    { personIds, limit }
  );
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

  return handleNonCriticalError(
    async () => {
  // 使用 SQL 查詢取得每個人的最新照片（使用 DISTINCT ON）
  const placeholders = generatePlaceholders(personIds);
  const sql = `
    SELECT DISTINCT ON (person_id)
      person_id,
      standard_head_portrait,
      thumbnail_head_portrait
    FROM platform.person_head_pic
    WHERE person_id IN (${placeholders})
    ORDER BY person_id, id DESC
  `;

    const rows = await externalDb.query(sql, personIds);
    const headPicMap = new Map();
    rows.forEach((row) => {
      headPicMap.set(row.person_id, row);
    });
    return headPicMap;
    },
    "無法批次取得人員照片",
    new Map(),
    { personIds }
  );
}

/**
 * SQL 查詢工具函數
 */

/**
 * 生成 SQL IN 子句的 placeholders
 * @param {Array<number>} ids - ID 列表
 * @param {number} startIndex - 參數起始索引，預設為 1
 * @returns {string} SQL placeholders 字串
 */
function generatePlaceholders(ids, startIndex = 1) {
  return ids.map((_, index) => `$${startIndex + index}`).join(", ");
}

/**
 * 使用 JOIN 查詢取得記錄（含關聯資料）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @param {Object} options - 查詢選項
 * @param {number} options.limit - 限制筆數
 * @param {number} options.daysAgo - 查詢幾天前的記錄，預設為 2（近兩天）
 * @returns {Promise<Array>} 記錄列表
 */
async function getRecordsWithJoin(personIds, options = {}) {
  if (personIds.length === 0) {
    return [];
  }

  const { limit, daysAgo = 2 } = options;

  return handleServiceError(
    async () => {
      const placeholders = generatePlaceholders(personIds);
      const startTime = getDaysAgoStart(daysAgo);
      const paramIndex = personIds.length + 1;

      const sql = `
        SELECT 
          r.person_id,
          r.swip_card_rev_time,
          r.snap_pic_url,
          r.physical_id,
          p.full_name AS person_name,
          p.person_group_id AS unit_id,
          pg.name AS unit_name
        FROM baseacs.slot_card_records r
        LEFT JOIN platform.person p ON r.person_id = p.id
        LEFT JOIN platform.person_group pg ON p.person_group_id = pg.id
        WHERE r.person_id IN (${placeholders})
          AND r.person_id != -1
          AND r.is_deleted = false
          AND r.swip_card_rev_time >= $${paramIndex}
        ORDER BY r.swip_card_rev_time DESC
        ${limit ? `LIMIT $${paramIndex + 1}` : ""}
      `;

      const params = [...personIds, startTime.toISOString()];
      if (limit) {
        params.push(limit);
      }

      const rows = await externalDb.query(sql, params);
      return rows;
    },
    "取得 JOIN 記錄失敗",
    { personIds, options }
  );
}

/**
 * 使用 JOIN 查詢取得近兩天記錄（含關聯資料）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @param {number} limit - 限制筆數
 * @returns {Promise<Array>} 記錄列表
 * @deprecated 使用 getRecordsWithJoin(personIds, { limit, daysAgo: 2 }) 替代
 */
async function getTodayRecordsWithJoin(personIds, limit) {
  return getRecordsWithJoin(personIds, { limit, daysAgo: 2 });
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
 * 計算今日統計（進場/出場人數，基於 physical_id）
 * @deprecated 此函數已被 calculateTodayStatsByPhysicalId 取代，保留僅為向後兼容
 * @param {Array} records - 記錄列表
 * @param {number} entryDoorId - 入口設備 ID
 * @param {number} exitDoorId - 出口設備 ID
 * @returns {Object} 統計資料
 */
function calculateTodayStats(records, entryDoorId, exitDoorId) {
  return calculateTodayStatsByPhysicalId(records, entryDoorId, exitDoorId);
}

/**
 * 計算當前在場人數（基於 physical_id）
 * @param {Array} records - 記錄列表
 * @param {number} entryDoorId - 入口設備 ID
 * @param {number} exitDoorId - 出口設備 ID
 * @returns {number} 當前在場人數
 */
function calculateCurrentCount(records, entryDoorId, exitDoorId) {
  if (records.length === 0) {
    return 0;
  }

  const personStatus = new Map();

  const sortedRecords = sortRecordsByTime(records);

  sortedRecords.forEach((record) => {
    const personId = record.person_id;
    if (personId === -1) return;

    const eventType = parseEventType(record, entryDoorId, exitDoorId);
    // 跳過失敗事件（未註冊人員）
    if (eventType === null) return;

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

  return handleNonCriticalError(
    async () => {
  const placeholders = generatePlaceholders(groupIds);
  const sql = `
    SELECT id, name
    FROM platform.person_group
    WHERE id IN (${placeholders})
      AND is_deleted = 0
  `;

    const rows = await externalDb.query(sql, groupIds);
    const groupMap = new Map();
    rows.forEach((row) => {
      groupMap.set(row.id, row);
    });
    return groupMap;
    },
    "無法取得群組資訊",
    new Map(),
    { groupIds }
  );
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

  return handleNonCriticalError(
    async () => {
  const placeholders = generatePlaceholders(groupIds);
  const sql = `
    SELECT person_group_id, id
    FROM platform.person
    WHERE person_group_id IN (${placeholders})
      AND person_type = 0
  `;

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
    },
    "無法取得群組的人員 ID",
    new Map(),
    { groupIds }
  );
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
    const { personGroupIds } = getPeopleCountingConfig(location);
    if (personGroupIds.length > 0) {
      // 確保 ID 類型一致
      const locationId = normalizeId(location.id);
      siteGroupMap.set(locationId, personGroupIds);
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
 * @param {number} entryDoorId - 入口設備 ID（可選）
 * @param {number} exitDoorId - 出口設備 ID（可選）
 * @returns {Promise<Array>} 單位列表
 */
async function getUnitsByGroupIds(groupIds, records, entryDoorId = null, exitDoorId = null) {
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

    // 計算當前在場人數（使用 physical_id 判斷）
    const currentCount = calculateCurrentCount(unitRecords, entryDoorId, exitDoorId);

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
  // 地點管理
  getPeopleCountingLocations,
  getPeopleCountingLocationById,
  createPeopleCountingLocation,
  updatePeopleCountingLocation,
  deletePeopleCountingLocation,
  // 輔助函數（供其他模組使用）
  getPeopleCountingConfig,
  generateRecordId,
  parseEventType,
  // 新增的業務邏輯 API
  getSites,
  getSiteStats,
  getSiteLogs,
  getUnitPersonnel,
};
