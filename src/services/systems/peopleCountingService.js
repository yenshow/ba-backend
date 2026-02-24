/**
 * 人流統計地點管理服務
 *
 * 使用統一地點管理架構，location_type = 'people_counting'。
 * 兩大流程：data_source = 'yscp'（YSCP 資料庫，人員/統計來自外部）；data_source = 'access_control'（門禁設備本系統，人員與權限由人員管理 API 處理）。
 */

const config = require("../../config");
const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const locationService = require("./locationService");
const externalDb = require("../../database/externalDb");
const logger = require("../../utils/logger");
const yscpPersonService = require("../yscp/yscpPersonService");
const { getTodayTimeRange } = require("../../utils/dateRangeUtils");
const peopleCountingSyncService = require("./peopleCountingSyncService");
const personnelService = require("../personnel/personnelService");

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
async function handleNonCriticalError(
  fn,
  warnMessage,
  defaultValue,
  context = {},
) {
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
  const {
    name,
    zoneId,
    personGroupIds,
    entryDoorId,
    exitDoorId,
    dataSource = "yscp",
    entryDeviceId,
    exitDeviceId,
  } = locationData;

  if (!name?.trim()) {
    throw createValidationError("地點名稱不能為空");
  }
  if (!isUpdate && !zoneId) {
    throw createValidationError("區域 ID 不能為空");
  }

  const effectiveDataSource =
    dataSource === "access_control" ? "access_control" : "yscp";

  if (effectiveDataSource === "yscp") {
    if (!isUpdate) {
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
    if (isUpdate && personGroupIds !== undefined) {
      if (!Array.isArray(personGroupIds) || personGroupIds.length === 0) {
        throw createValidationError("至少需要選擇一個進場單位");
      }
    }
    const finalEntry =
      entryDoorId !== undefined ? entryDoorId : locationData.currentEntry || null;
    const finalExit =
      exitDoorId !== undefined ? exitDoorId : locationData.currentExit || null;
    if (finalEntry && finalExit && finalEntry === finalExit) {
      throw createValidationError("入口和出口不能是同一個設備");
    }
  } else {
    if (!isUpdate && !entryDeviceId) {
      throw createValidationError("門禁入口設備 ID 不能為空");
    }
    if (isUpdate && entryDeviceId !== undefined && !entryDeviceId) {
      throw createValidationError("門禁入口設備 ID 不能為空");
    }
    if (entryDeviceId && exitDeviceId && entryDeviceId === exitDeviceId) {
      throw createValidationError("入口和出口不能是同一個設備");
    }
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
      const allLocations = zones.flatMap((zone) => ensureArray(zone.locations));
      return {
        locations: allLocations,
      };
    },
    "取得人流統計地點列表失敗",
    { options },
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
        (sys) => sys.systemType === "people_counting",
      );

      if (!hasPeopleCountingSystem) {
        throw createValidationError("地點類型不正確");
      }

      return { location };
    },
    "取得人流統計地點失敗",
    { id },
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
        dataSource = "yscp",
        entryDeviceId,
        exitDeviceId,
        accessControlGroups = [], // 相容保留；門禁人員改由人員管理 person_location_access 處理
      } = locationData;

      validateLocationData(locationData, false);

      const result = await locationService.createLocation(
        {
          zoneId: parseInt(zoneId),
          name: name.trim(),
          locationType: "people_counting",
          config: {
            personGroupIds,
            entryDoorId,
            exitDoorId,
            dataSource,
            entryDeviceId,
            exitDeviceId,
            accessControlGroups,
          },
        },
        userId,
      );

      return {
        message: "人流統計地點建立成功",
        location: result.location,
      };
    },
    "建立人流統計地點失敗",
    { userId },
  );
}

/**
 * 更新人流統計地點
 */
async function updatePeopleCountingLocation(id, locationData, userId) {
  return handleServiceError(
    async () => {
      const {
        name,
        personGroupIds,
        entryDoorId,
        exitDoorId,
        dataSource,
        entryDeviceId,
        exitDeviceId,
        accessControlGroups,
      } = locationData;

      const existing = await getPeopleCountingLocationById(id);
      const pcForValidation = ensureArray(existing.location.systems).find(
        (s) => s.systemType === "people_counting",
      );
      const validationData = {
        ...locationData,
        currentEntry: pcForValidation?.config?.entryDoorId,
        currentExit: pcForValidation?.config?.exitDoorId,
      };
      validateLocationData(validationData, true);

      const updates = {};
      if (name !== undefined) {
        updates.name = name.trim();
      }

      const pcSystem = ensureArray(existing.location.systems).find(
        (s) => s.systemType === "people_counting",
      );
      const existingConfig = pcSystem?.config || {};
      const currentConfig = {
        person_group_ids: existingConfig.personGroupIds || [],
        entry_door_id: existingConfig.entryDoorId ?? null,
        exit_door_id: existingConfig.exitDoorId ?? null,
        data_source: existingConfig.dataSource || "yscp",
        entry_device_id: existingConfig.entryDeviceId ?? null,
        exit_device_id: existingConfig.exitDeviceId ?? null,
        access_control_groups: existingConfig.accessControlGroups || [],
      };

      const config = {
        ...currentConfig,
        ...(personGroupIds !== undefined && {
          person_group_ids: personGroupIds,
        }),
        ...(entryDoorId !== undefined && { entry_door_id: entryDoorId }),
        ...(exitDoorId !== undefined && { exit_door_id: exitDoorId }),
        ...(dataSource !== undefined && { data_source: dataSource }),
        ...(entryDeviceId !== undefined && {
          entry_device_id: entryDeviceId,
        }),
        ...(exitDeviceId !== undefined && {
          exit_device_id: exitDeviceId,
        }),
        ...(accessControlGroups !== undefined && {
          access_control_groups: accessControlGroups,
        }),
      };

      const systemId = pcSystem?.id ? String(pcSystem.id) : null;

      const updateData = {
        ...(updates.name && { name: updates.name }),
        systems: [
          {
            ...(systemId && { id: systemId }),
            systemType: "people_counting",
            config: {
              personGroupIds: config.person_group_ids,
              entryDoorId: config.entry_door_id,
              exitDoorId: config.exit_door_id,
              dataSource: config.data_source,
              entryDeviceId: config.entry_device_id,
              exitDeviceId: config.exit_device_id,
              accessControlGroups: config.access_control_groups,
            },
          },
        ],
      };

      const result = await locationService.updateLocation(
        id,
        updateData,
        userId,
      );

      return {
        message: "人流統計地點更新成功",
        location: result.location,
      };
    },
    "更新人流統計地點失敗",
    { id, userId },
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
    { id },
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
 * 從設備 config.host 取出可與 isapi_access_events.device_ip 比對的 IP（去除協議與埠）
 */
function normalizeDeviceHost(host) {
  if (!host || typeof host !== "string") return "";
  const trimmed = host.trim();
  const m = trimmed.match(/^(?:https?:\/\/)?([^:/]+)/);
  return m ? m[1] : trimmed;
}

/**
 * 門禁地點進出紀錄：從 isapi_access_events 查詢，格式與 getSiteLogs 一致（同一進出紀錄區塊）
 * @param {number} siteId - 工地 ID（未用於查詢，保留介面一致）
 * @param {Object} options - entryDeviceId, exitDeviceId, limit, offset, startTime, endTime
 * @returns {Promise<Array>} logs 陣列
 */
async function getAccessControlSiteLogs(siteId, options = {}) {
  const {
    entryDeviceId,
    exitDeviceId,
    limit = 50,
    offset = 0,
    startTime: optStart,
    endTime: optEnd,
  } = options;

  const entryId = entryDeviceId != null && !Number.isNaN(Number(entryDeviceId)) ? Number(entryDeviceId) : null;
  const exitId = exitDeviceId != null && !Number.isNaN(Number(exitDeviceId)) ? Number(exitDeviceId) : null;
  if (entryId == null && exitId == null) return [];

  const ipToDeviceName = new Map();
  const entryIps = new Set();
  const exitIps = new Set();
  const allIps = [];

  const addDevice = async (deviceId, isEntry) => {
    try {
      const { device } = await deviceService.getDeviceById(deviceId);
      const host = device?.config?.host;
      const ip = normalizeDeviceHost(host);
      if (ip) {
        allIps.push(ip);
        ipToDeviceName.set(ip, device?.name || ip);
        if (isEntry) entryIps.add(ip);
        else exitIps.add(ip);
      }
    } catch (err) {
      logger.warn("取得門禁設備 IP 失敗，略過", { deviceId, error: err.message });
    }
  };

  if (entryId != null) await addDevice(entryId, true);
  if (exitId != null && exitId !== entryId) await addDevice(exitId, false);
  if (allIps.length === 0) return [];

  const start = optStart ? new Date(optStart) : getTodayTimeRange().start;
  const end = optEnd ? new Date(optEnd) : getTodayTimeRange().end;
  const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offsetNum = Math.max(Number(offset) || 0, 0);

  const placeholders = allIps.map(() => "?").join(",");
  const params = [...allIps, start.toISOString(), end.toISOString(), limitNum, offsetNum];
  const rows = await db.query(
    `SELECT id, device_ip, event_time, event_type, payload, picture_path
     FROM isapi_access_events
     WHERE device_ip IN (${placeholders}) AND event_time >= ? AND event_time <= ?
     ORDER BY event_time DESC
     LIMIT ? OFFSET ?`,
    params,
  );

  const getEmployeeNo = (payload) => {
    const v = payload.employeeNoString ?? payload.employeeNo;
    return v != null ? String(v).trim() : "";
  };
  const employeeNos = [...new Set((rows || []).map((r) => getEmployeeNo(typeof r.payload === "object" ? r.payload : {})).filter(Boolean))];

  const personByEmployeeNo = new Map();
  if (employeeNos.length > 0) {
    const placeholdersPerson = employeeNos.map(() => "?").join(",");
    const personRows = await db.query(
      `SELECT p.id, p.employee_no, p.full_name, p.person_group_id, pg.name AS unit_name
       FROM persons p
       LEFT JOIN person_groups pg ON p.person_group_id = pg.id
       WHERE p.employee_no IN (${placeholdersPerson})`,
      employeeNos,
    );
    for (const r of personRows || []) {
      const no = r.employee_no != null ? String(r.employee_no).trim() : "";
      if (no) {
        personByEmployeeNo.set(no, {
          personId: r.id,
          personName: r.full_name != null ? String(r.full_name).trim() : "",
          unitId: r.person_group_id != null ? Number(r.person_group_id) : null,
          unitName: r.unit_name != null ? String(r.unit_name).trim() : "",
        });
      }
    }
  }

  return (rows || []).map((row) => {
    const payload = typeof row.payload === "object" ? row.payload : {};
    const sub = payload.subEventType != null ? Number(payload.subEventType) : null;
    const eventType =
      sub === 76
        ? "failed"
        : entryIps.has(row.device_ip)
          ? "entry"
          : exitIps.has(row.device_ip)
            ? "exit"
            : "entry";
    const employeeId = getEmployeeNo(payload);
    const personInfo = employeeId ? personByEmployeeNo.get(employeeId) : null;

    return {
      id: `isapi-${row.id}`,
      personId: personInfo?.personId ?? null,
      personName: personInfo?.personName || "—",
      unitId: personInfo?.unitId ?? null,
      unitName: personInfo?.unitName ?? "",
      employeeId: employeeId || null,
      eventType,
      timestamp: row.event_time,
      deviceScreenshotUrl: row.picture_path || "",
      deviceName: ipToDeviceName.get(row.device_ip) || row.device_ip,
    };
  });
}

/**
 * 從門禁進出紀錄計算今日進場/出場/在場人數（與 YSCP countEntryExitFromSorted + calculateCurrentCount 語意一致）
 * @param {Array<{ employeeId?: string|null, eventType: string, timestamp: string }>} logs - 今日紀錄，需含 employeeId、eventType（entry/exit/failed）、timestamp
 * @returns {{ entryCount: number, exitCount: number, currentCount: number }}
 */
function calculateEntryExitCurrentFromAccessControlLogs(logs) {
  if (!logs || logs.length === 0) {
    return { entryCount: 0, exitCount: 0, currentCount: 0 };
  }
  const sorted = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const lastByPerson = new Map();
  let entryCount = 0;
  let exitCount = 0;
  for (const log of sorted) {
    const key = log.employeeId || "";
    if (!key || log.eventType === "failed") continue;
    const dir = log.eventType === "entry" || log.eventType === "exit" ? log.eventType : null;
    if (!dir) continue;
    const prev = lastByPerson.get(key);
    if (prev === undefined && dir === "exit") continue;
    if (prev !== dir) {
      if (dir === "entry") entryCount++;
      else exitCount++;
    }
    lastByPerson.set(key, dir);
  }
  const currentCount = [...lastByPerson.values()].filter((d) => d === "entry").length;
  return { entryCount, exitCount, currentCount };
}

/** 僅計算在場人數（供單位維度使用，避免重算 entry/exit） */
function currentCountFromAccessControlLogs(logs) {
  return calculateEntryExitCurrentFromAccessControlLogs(logs).currentCount;
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
  return handleServiceError(async () => {
    // 1. 取得所有地點（工地）
    const locationsResult = await locationService.getZones({
      locationType: "people_counting",
    });

    const sites = [];
    const allLocations = ensureArray(locationsResult.zones).flatMap((zone) =>
      ensureArray(zone.locations),
    );

    if (allLocations.length === 0) {
      return { sites: [] };
    }

    // 2. 批次取得所有工地的人員 ID 和記錄
    const siteDataMap = await batchGetSitesData(allLocations);

    // 3. 為每個地點計算統計
    // 注意：batchGetSitesData 僅處理 YSCP 群組；門禁地點 (dataSource === 'access_control') 改由人員管理 API 取得可進出人員並分組
    for (const location of allLocations) {
      const {
        personGroupIds,
        entryDoorId,
        exitDoorId,
        dataSource = "yscp",
        entryDeviceId: configEntryDeviceId,
        exitDeviceId: configExitDeviceId,
      } = getPeopleCountingConfig(location);

      const locationId = normalizeId(location.id);

      // 功能旗標：YSCP 關閉時不列入 yscp 地點
      if (
        dataSource === "yscp" &&
        config.features &&
        config.features.enableYscpPeopleCounting === false
      ) {
        continue;
      }

      // 門禁地點：可進出人員與單位由人員管理取得，進出/在場從今日 isapi_access_events 計算
      if (dataSource === "access_control") {
        const entryDeviceId = configEntryDeviceId ?? null;
        const exitDeviceId = configExitDeviceId ?? null;
        let units = [];
        let entryCount = 0;
        let exitCount = 0;
        try {
          const persons = await personnelService.getPersonsWithAccessByLocationId(locationId);
          const byGroup = new Map();
          for (const p of persons) {
            const gname = p.group_name || "未分組";
            if (!byGroup.has(gname)) byGroup.set(gname, []);
            byGroup.get(gname).push(p);
          }
          const { start, end } = getTodayTimeRange();
          const todayLogs =
            entryDeviceId != null || exitDeviceId != null
              ? await getAccessControlSiteLogs(locationId, {
                  entryDeviceId,
                  exitDeviceId,
                  startTime: start.toISOString(),
                  endTime: end.toISOString(),
                  limit: 2000,
                  offset: 0,
                })
              : [];
          const siteStats = calculateEntryExitCurrentFromAccessControlLogs(todayLogs);
          entryCount = siteStats.entryCount;
          exitCount = siteStats.exitCount;
          let idx = 0;
          units = [...byGroup.entries()].map(([name, list]) => {
            const employeeNos = new Set(list.map((p) => String(p.employee_no)));
            const unitLogs = todayLogs.filter((log) => employeeNos.has(log.employeeId || ""));
            return {
              id: ++idx,
              name,
              currentCount: currentCountFromAccessControlLogs(unitLogs),
              totalCount: list.length,
            };
          });
        } catch (err) {
          logger.warn("取得門禁地點可進出人員失敗，顯示空單位", { locationId, error: err.message });
        }
        sites.push({
          id: locationId,
          name: location.name,
          entryCount,
          exitCount,
          units,
        });
        continue;
      }

      // YSCP 地點：需有進場單位且能取得工地資料
      if (personGroupIds.length === 0) {
        continue;
      }

      const siteData = siteDataMap.get(locationId);
      if (!siteData) {
        continue;
      }

      // 計算統計（使用事件序列邏輯，確保先進後出）
      // siteData.records 已經是今日記錄，由 getTodayRecordsOnly 過濾
      const stats = calculateTodayStatsByPhysicalId(
        siteData.records,
        entryDoorId,
        exitDoorId,
      );

      // 取得單位列表（傳入設備 ID）
      const units = await getUnitsByGroupIds(
        personGroupIds,
        siteData.records,
        entryDoorId,
        exitDoorId,
      );

      sites.push({
        id: locationId,
        name: location.name,
        entryCount: stats.entryCount,
        exitCount: stats.exitCount,
        units: units,
      });
    }

    return { sites };
  }, "取得工地列表失敗");
}

/**
 * 取得工地統計
 * @param {number} siteId - 工地 ID
 * @returns {Promise<Object>} 統計資料
 */
async function getSiteStats(siteId) {
  return handleServiceError(
    async () => {
      const { personGroupIds, entryDoorId, exitDoorId, dataSource, entryDeviceId, exitDeviceId } =
        await getSiteConfig(siteId);

      // 門禁地點：從今日 isapi_access_events 計算進場/出場/在場（與 YSCP 語意一致）
      if (dataSource === "access_control") {
        const { start, end } = getTodayTimeRange();
        const todayLogs = await getAccessControlSiteLogs(siteId, {
          entryDeviceId,
          exitDeviceId,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          limit: 2000,
          offset: 0,
        });
        return calculateEntryExitCurrentFromAccessControlLogs(todayLogs);
      }

      if (personGroupIds.length === 0) {
        return { entryCount: 0, exitCount: 0, currentCount: 0 };
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

      // 單次遍歷計算進場/出場/在場人數
      const { entryCount, exitCount, currentCount } =
        calculateTodayStatsAndCurrentCount(
          todayRecords,
          entryDoorId,
          exitDoorId,
        );

      return {
        entryCount,
        exitCount,
        currentCount,
      };
    },
    "取得工地統計失敗",
    { siteId },
  );
}

/**
 * 取得工地進出場記錄（含資料關聯和事件類型判斷）
 * @param {number} siteId - 工地 ID
 * @param {Object} options - 選項
 * @param {number} options.limit - 限制筆數
 * @param {number} options.unitId - 單位 ID（可選）
 * @param {string} options.startTime - 開始時間 ISO 字串（可選，未傳則預設今日）
 * @param {string} options.endTime - 結束時間 ISO 字串（可選，未傳則預設今日）
 * @returns {Promise<Object>} 記錄列表
 */
async function getSiteLogs(siteId, options = {}) {
  return handleServiceError(
    async () => {
      const { limit = 50, offset = 0, unitId, startTime, endTime } = options;

      const { entryDoorId, exitDoorId, dataSource, entryDeviceId, exitDeviceId } =
        await getSiteConfig(siteId);

      // 門禁地點：進出記錄來自 isapi_access_events（與 YSCP 同一進出紀錄區塊）
      if (dataSource === "access_control") {
        const accessControlLogs = await getAccessControlSiteLogs(siteId, {
          entryDeviceId,
          exitDeviceId,
          limit,
          offset,
          startTime,
          endTime,
        });
        return { logs: accessControlLogs };
      }
      // 功能旗標：YSCP 關閉時回傳空
      if (config.features && config.features.enableYscpPeopleCounting === false) {
        return { logs: [] };
      }

      const allowedPhysicalIds = [entryDoorId, exitDoorId]
        .filter((v) => v !== null && v !== undefined)
        .map((v) => Number(v))
        .filter((v) => !Number.isNaN(v));

      if (allowedPhysicalIds.length === 0) {
        return { logs: [] };
      }

      // 取得刷卡記錄（用 physical_id 查，才能包含未註冊人員 person_id = -1）
      // - 若有 unitId，仍可在 SQL 中篩選對應單位（person_group_id），未註冊人員會自然被排除
      // - startTime / endTime 未傳時，getRecordsByPhysicalIdsWithJoin 內建使用今日範圍
      // - offset 用於分頁
      const records = await getRecordsByPhysicalIdsWithJoin(allowedPhysicalIds, {
        limit,
        offset: Math.max(0, Number(offset) || 0),
        unitId: unitId || null,
        ...(startTime && { startTime }),
        ...(endTime && { endTime }),
      });

      // 判斷事件類型
      // 按時間降序排序（最新的在最上方）
      const sortedRecords = [...records].sort(
        (a, b) =>
          new Date(b.swip_card_rev_time).getTime() -
          new Date(a.swip_card_rev_time).getTime(),
      );

      const physicalIds = [
        ...new Set(
          sortedRecords
            .map((r) => r.physical_id)
            .filter((id) => id != null && id !== ""),
        ),
      ];
      const doorNameMap = await peopleCountingSyncService.getDoorNamesByPhysicalIds(
        physicalIds,
      );

      const logs = sortedRecords.map((record) => {
        const eventType = parseEventType(record, entryDoorId, exitDoorId);
        const physicalId = record.physical_id != null ? Number(record.physical_id) : null;
        const deviceName =
          physicalId != null ? (doorNameMap.get(physicalId) ?? "") : "";

        return {
          id: generateRecordId(record.person_id, record.swip_card_rev_time),
          personId: record.person_id,
          personName: record.person_name || "陌生人員",
          unitId: record.unit_id || null,
          unitName: record.unit_name || "",
          employeeId:
            record.employee_no != null && String(record.employee_no).trim() !== ""
              ? String(record.employee_no).trim()
              : null,
          eventType: eventType || "failed", // 未註冊人員標記為 "failed"
          timestamp: record.swip_card_rev_time,
          deviceScreenshotUrl: record.snap_pic_url || "",
          deviceName,
        };
      });

      return { logs };
    },
    "取得工地進出場記錄失敗",
    { siteId, options },
  );
}

/**
 * 依 physical_id 取得刷卡記錄（含關聯資料）
 * - 可包含未註冊人員（person_id = -1）
 * - 可選擇以 unitId（person_group_id）做篩選
 * - 可傳入 startTime / endTime（ISO 字串）指定時間範圍；未傳則預設為今日
 */
async function getRecordsByPhysicalIdsWithJoin(physicalIds, options = {}) {
  if (!Array.isArray(physicalIds) || physicalIds.length === 0) {
    return [];
  }

  const { limit = 50, offset = 0, unitId = null, startTime: optStart, endTime: optEnd } = options;
  const start = optStart ? new Date(optStart) : getTodayTimeRange().start;
  const end = optEnd ? new Date(optEnd) : getTodayTimeRange().end;

  const placeholders = generatePlaceholders(physicalIds);
  const baseParamIndex = physicalIds.length + 1;
  const unitFilterSql = unitId
    ? `AND p.person_group_id = $${baseParamIndex + 2}`
    : "";
  const offsetParamIndex = baseParamIndex + (unitId ? 3 : 2);
  const limitParamIndex = offsetParamIndex + 1;
  const rangeSql =
    limit > 0 ? `OFFSET $${offsetParamIndex} LIMIT $${limitParamIndex}` : "";

  const sql = `
    SELECT 
      r.person_id,
      r.swip_card_rev_time,
      r.snap_pic_url,
      r.physical_id,
      p.full_name AS person_name,
      p.person_group_id AS unit_id,
      pg.name AS unit_name,
      p.person_code AS employee_no
    FROM baseacs.slot_card_records r
    LEFT JOIN platform.person p ON r.person_id = p.id
    LEFT JOIN platform.person_group pg ON p.person_group_id = pg.id
    WHERE r.physical_id IN (${placeholders})
      AND r.is_deleted = false
      AND r.swip_card_rev_time >= $${baseParamIndex}
      AND r.swip_card_rev_time <= $${baseParamIndex + 1}
      ${unitFilterSql}
    ORDER BY r.swip_card_rev_time DESC
    ${rangeSql}
  `;

  const params = [...physicalIds, start.toISOString(), end.toISOString()];
  if (unitId) params.push(unitId);
  if (limit > 0) {
    params.push(Math.max(0, Number(offset) || 0));
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
    { personIds },
  );
}

/**
 * 進出場計數核心（與備份、前端一致）：同人連續同向只計一次，首筆為出場不計。
 * @param {Array} sortedRecords - 已依時間升序的記錄，須含 person_id
 * @param {Function} getDirection - (record) => "entry" | "exit" | null
 * @returns {{ entryCount: number, exitCount: number }}
 */
function countEntryExitFromSorted(sortedRecords, getDirection) {
  const lastByPerson = new Map();
  let entryCount = 0;
  let exitCount = 0;
  for (const record of sortedRecords) {
    const dir = getDirection(record);
    if (dir !== "entry" && dir !== "exit") continue;
    const personId = record.person_id;
    const prev = lastByPerson.get(personId);
    if (prev === undefined && dir === "exit") continue;
    if (prev !== dir) {
      if (dir === "entry") entryCount++;
      else exitCount++;
      lastByPerson.set(personId, dir);
    }
  }
  return { entryCount, exitCount };
}

/**
 * 計算今日統計（進場/出場人數，基於 physical_id）
 * 複用 countEntryExitFromSorted，邏輯與備份 CSV、前端一致。
 */
function calculateTodayStatsByPhysicalId(records, entryDoorId, exitDoorId) {
  if (records.length === 0) return { entryCount: 0, exitCount: 0 };
  const sortedRecords = sortRecordsByTime(records);
  const getDirection = (r) => parseEventType(r, entryDoorId, exitDoorId);
  return countEntryExitFromSorted(sortedRecords, getDirection);
}

/**
 * 計算今日進場/出場人數與當前在場人數；在場人數複用 calculateCurrentCount，確保邏輯單一。
 * @param {Array} records - 記錄列表（應只包含今日記錄）
 * @param {number} entryDoorId - 入口設備 ID
 * @param {number} exitDoorId - 出口設備 ID
 * @returns {{ entryCount: number, exitCount: number, currentCount: number }}
 */
function calculateTodayStatsAndCurrentCount(records, entryDoorId, exitDoorId) {
  const { entryCount, exitCount } = calculateTodayStatsByPhysicalId(
    records,
    entryDoorId,
    exitDoorId,
  );
  const currentCount = calculateCurrentCount(
    records,
    entryDoorId,
    exitDoorId,
  );
  return { entryCount, exitCount, currentCount };
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
 * @param {number} unitId - 單位 ID（YSCP 為 person_group_id；門禁地點為「可進出人員分組」的序號 1-based）
 * @param {number} siteId - 工地 ID（可選，用於取得入口/出口設備 ID；門禁地點時必填，且人員來自人員管理 API）
 * @returns {Promise<Object>} 人員列表
 */
async function getUnitPersonnel(unitId, siteId = null) {
  return handleServiceError(
    async () => {
      let entryDoorId = null;
      let exitDoorId = null;

      // 如果提供了 siteId，從地點取得配置（含是否為門禁地點）
      if (siteId) {
        const config = await handleNonCriticalError(
          async () => await getSiteConfig(siteId),
          "無法取得工地配置，使用預設值",
          null,
          { siteId, unitId },
        );
        if (config) {
          entryDoorId = config.entryDoorId;
          exitDoorId = config.exitDoorId;
          // 門禁地點：可進出人員改由人員管理 API 取得，依群組名稱分組後依序對應 unitId；並從 isapi_access_events 填今日進出紀錄
          if (config.dataSource === "access_control") {
            const persons = await personnelService.getPersonsWithAccessByLocationId(siteId);
            const byGroup = new Map();
            for (const p of persons) {
              const gname = p.group_name || "未分組";
              if (!byGroup.has(gname)) byGroup.set(gname, []);
              byGroup.get(gname).push(p);
            }
            const groupList = [...byGroup.entries()];
            const idx = Math.max(0, Number(unitId) - 1);
            const group = groupList[idx];
            if (!group) {
              return { personnel: [], entryCount: 0, exitCount: 0 };
            }
            const [, list] = group;
            const employeeNosInUnit = new Set(list.map((p) => String(p.employee_no)));

            // 今日門禁事件，用於填寫每人進出時間與單位統計
            const { start: todayStart, end: todayEnd } = getTodayTimeRange();
            const todayLogs = await getAccessControlSiteLogs(siteId, {
              entryDeviceId: config.entryDeviceId,
              exitDeviceId: config.exitDeviceId,
              startTime: todayStart.toISOString(),
              endTime: todayEnd.toISOString(),
              limit: 500,
              offset: 0,
            });
            const entryCount = todayLogs.filter(
              (log) => log.eventType === "entry" && employeeNosInUnit.has(log.employeeId || ""),
            ).length;
            const exitCount = todayLogs.filter(
              (log) => log.eventType === "exit" && employeeNosInUnit.has(log.employeeId || ""),
            ).length;
            // 每人最近進場/出場（今日事件依時間降序，第一次遇到即為最近）
            const lastEntryByNo = new Map();
            const lastExitByNo = new Map();
            for (const log of todayLogs) {
              const no = log.employeeId || "";
              if (!employeeNosInUnit.has(no)) continue;
              const ts = log.timestamp;
              if (log.eventType === "entry" && !lastEntryByNo.has(no)) lastEntryByNo.set(no, ts);
              if (log.eventType === "exit" && !lastExitByNo.has(no)) lastExitByNo.set(no, ts);
            }

            const personnel = list.map((p) => {
              const no = String(p.employee_no);
              const lastEntry = lastEntryByNo.get(no);
              const lastExit = lastExitByNo.get(no);
              const entryDate = lastEntry ? new Date(lastEntry) : null;
              const exitDate = lastExit ? new Date(lastExit) : null;
              const isPresent =
                lastEntry && (!lastExit || new Date(lastExit) < new Date(lastEntry));
              const isTodayEntry = entryDate && entryDate >= todayStart && entryDate <= todayEnd;
              const faceUrl = p.face_url != null ? String(p.face_url).trim() : "";
              const photoUrl =
                faceUrl !== "" ? (faceUrl.startsWith("/") ? faceUrl : `/${faceUrl}`) : undefined;
              return {
                id: p.id,
                unitId: p.person_group_id || 0,
                employeeId: no,
                name: p.full_name || p.employee_no || "",
                photoUrl,
                isPresent: !!isPresent,
                lastEntryTime: lastEntry || null,
                lastExitTime: lastExit || null,
                lastEntryDate: entryDate ? entryDate.toISOString().slice(0, 10) : null,
                entryTime: entryDate ? entryDate.toTimeString().slice(0, 8) : null,
                exitTime: exitDate ? exitDate.toTimeString().slice(0, 8) : null,
                isTodayEntry: !!isTodayEntry,
              };
            });
            return { personnel, entryCount, exitCount };
          }
        }
      }
      // YSCP：取得該單位的人員（直接使用 SQL 查詢，含 person_code 作為員工編號）
      const sql = `
      SELECT id, person_group_id, person_type, full_name, person_code
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
          exitCount: 0,
        };
      }

      const personIds = persons.map((p) => p.id);

      // 批次取得人員照片（優化：使用 SQL 查詢）
      const headPicMap = await batchGetHeadPics(personIds);

      // 取得今日刷卡記錄（00:00 - 24:00，用於統計和人員狀態）
      const todayRecords = await getTodayRecordsOnly(personIds);

      // 計算今日進場/出場人數統計
      const todayStats = calculateTodayStatsByPhysicalId(
        todayRecords,
        entryDoorId,
        exitDoorId,
      );

      // 取得今日時間範圍（用於判斷是否為今日進場）
      const { start: todayStart, end: todayEnd } = getTodayTimeRange();

      // 預先建立每個人的今日記錄 Map（優化：避免在循環中重複過濾）
      const personTodayRecordsMap = new Map();
      todayRecords.forEach((record) => {
        const personId = record.person_id;
        if (personId !== -1) {
          if (!personTodayRecordsMap.has(personId)) {
            personTodayRecordsMap.set(personId, []);
          }
          personTodayRecordsMap.get(personId).push(record);
        }
      });

      // 取得所有人的最近進場/出場記錄（不受時間限制，用於顯示最近進場日期）
      const latestRecords = await getLatestEntryExitRecords(
        personIds,
        entryDoorId,
        exitDoorId,
      );

      // 建立人員列表
      const personnel = persons.map((person) => {
        const headPic = headPicMap.get(person.id);
        const personTodayRecords = personTodayRecordsMap.get(person.id) || [];
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
        let isTodayEntry = false;
        let entryTimeStr = null;
        let entryTime = null;

        if (lastEntryRecord) {
          entryTime = new Date(lastEntryRecord.swip_card_rev_time);

          // 檢查是否為今日進場
          isTodayEntry = entryTime >= todayStart && entryTime <= todayEnd;

          // 格式化日期和時間
          lastEntryDate = formatDate(entryTime);
          entryTimeStr = formatTime(entryTime);
        }

        // 處理出場記錄
        let exitTimeStr = null;
        let exitTime = null;

        if (isTodayEntry) {
          // 今日進場：取該次進場後「最早一筆」出場（成對）；personTodayRecords 已按時間升序
          const todayExitRecord = personTodayRecords.find((r) => {
            const recordTime = new Date(r.swip_card_rev_time);
            const eventType = parseEventType(r, entryDoorId, exitDoorId);
            return eventType === "exit" && recordTime > entryTime;
          });

          if (todayExitRecord) {
            exitTime = new Date(todayExitRecord.swip_card_rev_time);
            exitTimeStr = formatTime(exitTime);
          }
          // 如果今日沒有出場記錄，exitTimeStr 保持為 null（前端會顯示 "- -"）
        } else if (lastExitRecord) {
          // 如果不是今日進場，顯示最近出場時間
          exitTime = new Date(lastExitRecord.swip_card_rev_time);
          exitTimeStr = formatTime(exitTime);
        }

        // 判斷是否在場（isPresent）
        // 邏輯：
        // 1. 如果沒有進場記錄，則不在場
        // 2. 只有今日進場且沒有今日出場時，才在場
        // 3. 如果不是今日進場，無論是否有出場記錄，都不在場（因為進場是昨天或更早的）
        let isPresent = false;
        if (lastEntryRecord && isTodayEntry) {
          // 只有今日進場時才判斷是否在場
          if (!exitTime) {
            // 今日沒有出場，則在場
            isPresent = true;
          } else {
            // 今日有出場，比較時間（如果出場時間 <= 進場時間，表示邏輯錯誤，但為了安全起見仍判斷為不在場）
            isPresent = exitTime <= entryTime;
          }
        }
        // 如果不是今日進場，isPresent 保持為 false（不在場）

        return {
          id: person.id,
          employeeId:
            person.person_code != null && String(person.person_code).trim() !== ""
              ? String(person.person_code).trim()
              : "",
          name: person.full_name || "",
          photoUrl: photoUrl,
          isInside: isPresent, // 與 isPresent 保持一致（向後兼容）
          isPresent: isPresent,
          lastEntryTime: lastEntryRecord
            ? lastEntryRecord.swip_card_rev_time
            : null,
          lastExitTime: lastExitRecord
            ? lastExitRecord.swip_card_rev_time
            : null,
          lastEntryDate: lastEntryDate,
          entryTime: entryTimeStr,
          exitTime: exitTimeStr,
          isTodayEntry: isTodayEntry,
        };
      });

      return {
        personnel,
        entryCount: todayStats.entryCount,
        exitCount: todayStats.exitCount,
      };
    },
    "取得單位人員列表失敗",
    { unitId, siteId },
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
 * @returns {Object} { peopleCountingSystem, entryDoorId, exitDoorId, personGroupIds, dataSource, entryDeviceId, exitDeviceId, accessControlGroups }
 * @deprecated accessControlGroups 僅相容保留；門禁流程之可進出人員改由 personnelService.getPersonsWithAccessByLocationId 取得
 */
function getPeopleCountingConfig(location) {
  const peopleCountingSystem = ensureArray(location.systems).find(
    (sys) => sys.systemType === "people_counting",
  );
  return {
    peopleCountingSystem,
    entryDoorId: peopleCountingSystem?.config?.entryDoorId || null,
    exitDoorId: peopleCountingSystem?.config?.exitDoorId || null,
    personGroupIds: ensureArray(peopleCountingSystem?.config?.personGroupIds),
    dataSource: peopleCountingSystem?.config?.dataSource || "yscp",
    entryDeviceId: peopleCountingSystem?.config?.entryDeviceId ?? null,
    exitDeviceId: peopleCountingSystem?.config?.exitDeviceId ?? null,
    accessControlGroups: ensureArray(peopleCountingSystem?.config?.accessControlGroups),
  };
}

/**
 * 取得工地配置（統一處理地點取得和配置解析）
 * @param {number} siteId - 工地 ID
 * @returns {Promise<Object>} { location, personGroupIds, entryDoorId, exitDoorId, dataSource, entryDeviceId, exitDeviceId, accessControlGroups }
 * @deprecated accessControlGroups 僅相容保留
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
    dataSource: config.dataSource,
    entryDeviceId: config.entryDeviceId,
    exitDeviceId: config.exitDeviceId,
    accessControlGroups: config.accessControlGroups,
  };
}

/**
 * 統一 ID 類型轉換（確保 ID 為數字）
 * @param {string|number} id - ID 值
 * @returns {number} 轉換後的數字 ID
 */
function normalizeId(id) {
  return typeof id === "string" ? Number(id) : id;
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
    { groupIds },
  );
}

/**
 * 取得今日刷卡記錄
 * @deprecated 請使用 getTodayRecordsOnly()，此函數保留僅為向後兼容
 * @param {Array<number>} personIds - 人員 ID 列表
 * @returns {Promise<Array>} 記錄列表
 */
async function getTodayRecords(personIds) {
  return getTodayRecordsOnly(personIds);
}

/**
 * 取得指定人員的今日刷卡記錄
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
      const { start, end } = getTodayTimeRange();
      let sql = `
    SELECT *
    FROM baseacs.slot_card_records
    WHERE person_id IN (${placeholders})
      AND person_id != -1
      AND is_deleted = false
      AND swip_card_rev_time >= $${personIds.length + 1}
      AND swip_card_rev_time <= $${personIds.length + 2}
    ORDER BY swip_card_rev_time DESC
  `;

      const params = [...personIds, start.toISOString(), end.toISOString()];
      if (limit) {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(limit);
      }

      const rows = await externalDb.query(sql, params);
      return rows;
    },
    "無法取得人員的刷卡記錄",
    [],
    { personIds, limit },
  );
}

/**
 * 批次取得人員照片（使用 YSCP API）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @returns {Promise<Map<number, Object>>} 人員 ID -> 照片資料的映射
 * 返回格式：{ person_id, standard_head_portrait, thumbnail_head_portrait }
 */
async function batchGetHeadPics(personIds) {
  if (personIds.length === 0) {
    return new Map();
  }

  return handleNonCriticalError(
    async () => {
      const results = await yscpPersonService.getBatchPersonInfo(personIds, {
        includePicture: true,
      });

      const headPicMap = new Map();

      results.forEach((result) => {
        if (result.success && result.personInfo) {
          const personId = parseInt(result.personId, 10);
          const pictureUrl = result.picture
            ? `data:image/jpeg;base64,${result.picture}`
            : null;

          headPicMap.set(personId, {
            person_id: personId,
            standard_head_portrait: pictureUrl,
            thumbnail_head_portrait: pictureUrl,
          });
        }
      });

      return headPicMap;
    },
    "無法批次取得人員照片",
    new Map(),
    { personIds },
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
 * 使用 JOIN 查詢取得今日記錄（含關聯資料）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @param {Object} options - 查詢選項
 * @param {number} options.limit - 限制筆數
 * @returns {Promise<Array>} 記錄列表
 */
async function getRecordsWithJoin(personIds, options = {}) {
  if (personIds.length === 0) {
    return [];
  }

  const { limit } = options;

  return handleServiceError(
    async () => {
      const placeholders = generatePlaceholders(personIds);
      const { start, end } = getTodayTimeRange();
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
          AND r.swip_card_rev_time <= $${paramIndex + 1}
        ORDER BY r.swip_card_rev_time DESC
        ${limit ? `LIMIT $${paramIndex + 2}` : ""}
      `;

      const params = [...personIds, start.toISOString(), end.toISOString()];
      if (limit) params.push(limit);

      const rows = await externalDb.query(sql, params);
      return rows;
    },
    "取得 JOIN 記錄失敗",
    { personIds, options },
  );
}

/**
 * 使用 JOIN 查詢取得今日記錄（含關聯資料）
 * @param {Array<number>} personIds - 人員 ID 列表
 * @param {number} limit - 限制筆數
 * @returns {Promise<Array>} 記錄列表
 * @deprecated 使用 getRecordsWithJoin(personIds, { limit }) 替代
 */
async function getTodayRecordsWithJoin(personIds, limit) {
  return getRecordsWithJoin(personIds, { limit });
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
      new Date(b.swip_card_rev_time).getTime(),
  );
}

/**
 * 計算當前在場人數（基於 physical_id）
 * 語意：當日有刷卡記錄且「最後一筆」為進場的人數；昨日進場、今日未刷卡者不計入。
 * @param {Array} records - 記錄列表（應只包含今日記錄）
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
    { groupIds },
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
    { groupIds },
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

  // 批次取得今日所有記錄（統一使用 getTodayRecordsOnly）
  const todayRecords = await getTodayRecordsOnly(Array.from(allPersonIds));

  // 為每個工地建立資料
  siteGroupMap.forEach((groupIds, siteId) => {
    const sitePersonIds = new Set();
    groupIds.forEach((groupId) => {
      const personIds = groupPersonMap.get(groupId) || [];
      personIds.forEach((id) => sitePersonIds.add(id));
    });

    // 過濾該工地的人員記錄
    // getTodayRecordsOnly 已經過濾了今日時間範圍，這裡只需要過濾人員 ID
    const siteRecords = todayRecords.filter(
      (r) => r.person_id !== -1 && sitePersonIds.has(r.person_id),
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
async function getUnitsByGroupIds(
  groupIds,
  records,
  entryDoorId = null,
  exitDoorId = null,
) {
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
      (r) => r.person_id !== -1 && unitPersonIds.includes(r.person_id),
    );

    // 計算當前在場人數（使用 physical_id 判斷）
    const currentCount = calculateCurrentCount(
      unitRecords,
      entryDoorId,
      exitDoorId,
    );

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
  countEntryExitFromSorted,
  // 業務邏輯 API
  getSites,
  getSiteStats,
  getSiteLogs,
  getUnitPersonnel,
};
