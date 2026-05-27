/**
 * YSCP 人流統計 Provider
 * 實作 getSiteData、getSiteLogs、getUnitPersonnel；資料來源為外部 DB（platform.person、baseacs.slot_card_records）。
 */

const externalDb = require("../../../database/externalDb");
const yscpPersonService = require("../../yscp/yscpPersonService");
const peopleCountingSyncService = require("../peopleCountingSyncService");
const { resolveStatsTimeRange } = require("../../entryExit/resolveTimeOptions");
const logger = require("../../../utils/logger");
const {
  parseEventType,
  sortRecordsByTime,
  calculateTodayStatsByPhysicalId,
} = require("../helpers/entryExitStats");
const { yscpEventLabel } = require("../accessControlLogLabels");

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function generatePlaceholders(ids, startIndex = 1) {
  return ids.map((_, i) => `$${startIndex + i}`).join(", ");
}

async function handleNonCriticalError(
  fn,
  warnMessage,
  defaultValue,
  context = {},
) {
  try {
    return await fn();
  } catch (error) {
    logger.warn(warnMessage, { error, ...context, module: "yscpProvider" });
    return defaultValue;
  }
}

async function getPersonIdsByGroupIds(groupIds) {
  if (groupIds.length === 0) return [];
  return handleNonCriticalError(
    async () => {
      const placeholders = generatePlaceholders(groupIds);
      const sql = `SELECT DISTINCT id FROM platform.person WHERE person_group_id IN (${placeholders}) AND person_type = 0`;
      const rows = await externalDb.query(sql, groupIds);
      return rows.map((r) => r.id);
    },
    "無法取得群組的人員",
    [],
    { groupIds },
  );
}

async function getTodayRecordsOnly(personIds) {
  if (personIds.length === 0) return [];
  return handleNonCriticalError(
    async () => {
      const { start, end } = resolveStatsTimeRange({});
      const placeholders = generatePlaceholders(personIds);
      const sql = `
        SELECT * FROM baseacs.slot_card_records
        WHERE person_id IN (${placeholders}) AND person_id != -1 AND is_deleted = false
          AND swip_card_rev_time >= $${personIds.length + 1} AND swip_card_rev_time <= $${personIds.length + 2}
        ORDER BY swip_card_rev_time ASC`;
      const params = [...personIds, start.toISOString(), end.toISOString()];
      return await externalDb.query(sql, params);
    },
    "無法取得今日刷卡記錄",
    [],
    { personIds },
  );
}

async function getRecordsByPhysicalIdsWithJoin(physicalIds, options = {}) {
  if (!Array.isArray(physicalIds) || physicalIds.length === 0) return [];
  const {
    limit = 50,
    offset = 0,
    unitId = null,
    startTime: optStart,
    endTime: optEnd,
  } = options;
  const { start, end } = resolveStatsTimeRange({
    startTime: optStart,
    endTime: optEnd,
    timeRange: options.timeRange,
  });
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
    SELECT r.person_id, r.swip_card_rev_time, r.snap_pic_url, r.physical_id,
           p.full_name AS person_name, p.person_group_id AS unit_id, pg.name AS unit_name, p.person_code AS employee_no
    FROM baseacs.slot_card_records r
    LEFT JOIN platform.person p ON r.person_id = p.id
    LEFT JOIN platform.person_group pg ON p.person_group_id = pg.id
    WHERE r.physical_id IN (${placeholders}) AND r.is_deleted = false
      AND r.swip_card_rev_time >= $${baseParamIndex} AND r.swip_card_rev_time <= $${baseParamIndex + 1}
      ${unitFilterSql}
    ORDER BY r.swip_card_rev_time DESC ${rangeSql}`;
  const params = [...physicalIds, start.toISOString(), end.toISOString()];
  if (unitId) params.push(unitId);
  if (limit > 0) {
    params.push(Math.max(0, Number(offset) || 0));
    params.push(limit);
  }
  return await externalDb.query(sql, params);
}

async function batchGetGroups(groupIds) {
  if (groupIds.length === 0) return new Map();
  return handleNonCriticalError(
    async () => {
      const placeholders = generatePlaceholders(groupIds);
      const sql = `SELECT id, name FROM platform.person_group WHERE id IN (${placeholders}) AND is_deleted = 0`;
      const rows = await externalDb.query(sql, groupIds);
      const m = new Map();
      rows.forEach((r) => m.set(r.id, r));
      return m;
    },
    "無法取得群組資訊",
    new Map(),
    { groupIds },
  );
}

async function batchGetGroupPersonIds(groupIds) {
  if (groupIds.length === 0) return new Map();
  return handleNonCriticalError(
    async () => {
      const placeholders = generatePlaceholders(groupIds);
      const sql = `SELECT person_group_id, id FROM platform.person WHERE person_group_id IN (${placeholders}) AND person_type = 0`;
      const rows = await externalDb.query(sql, groupIds);
      const m = new Map();
      groupIds.forEach((id) => m.set(id, []));
      rows.forEach((r) => {
        const list = m.get(r.person_group_id) || [];
        list.push(r.id);
        m.set(r.person_group_id, list);
      });
      return m;
    },
    "無法取得群組的人員 ID",
    new Map(),
    { groupIds },
  );
}

async function getUnitsByGroupIds(groupIds, records, entryDoorIds, exitDoorIds) {
  if (groupIds.length === 0) return [];
  const groupMap = await batchGetGroups(groupIds);
  const groupPersonMap = await batchGetGroupPersonIds(groupIds);
  const units = [];
  groupIds.forEach((groupId) => {
    const group = groupMap.get(groupId);
    if (!group) return;
    const unitPersonIds = groupPersonMap.get(groupId) || [];
    const unitRecords = records.filter(
      (r) => r.person_id !== -1 && unitPersonIds.includes(r.person_id),
    );
    const currentCount = calculateTodayStatsByPhysicalId(
      unitRecords,
      entryDoorIds,
      exitDoorIds,
    ).currentCount;
    units.push({
      id: group.id,
      name: group.name,
      currentCount,
      totalCount: unitPersonIds.length,
    });
  });
  return units;
}

async function batchGetSitesData(locations, getPeopleCountingConfig) {
  const siteDataMap = new Map();
  const allGroupIds = new Set();
  const siteGroupMap = new Map();
  locations.forEach((location) => {
    const { personGroupIds } = getPeopleCountingConfig(location);
    if (personGroupIds.length > 0) {
      const locationId =
        typeof location.id === "string" ? Number(location.id) : location.id;
      siteGroupMap.set(locationId, personGroupIds);
      personGroupIds.forEach((id) => allGroupIds.add(id));
    }
  });
  if (allGroupIds.size === 0) return siteDataMap;
  const groupPersonMap = await batchGetGroupPersonIds(Array.from(allGroupIds));
  const allPersonIds = new Set();
  groupPersonMap.forEach((personIds) =>
    personIds.forEach((id) => allPersonIds.add(id)),
  );
  if (allPersonIds.size === 0) return siteDataMap;
  const todayRecords = await getTodayRecordsOnly(Array.from(allPersonIds));
  siteGroupMap.forEach((groupIds, siteId) => {
    const sitePersonIds = new Set();
    groupIds.forEach((groupId) => {
      (groupPersonMap.get(groupId) || []).forEach((id) =>
        sitePersonIds.add(id),
      );
    });
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

async function getLatestEntryExitRecords(personIds, entryDoorIds, exitDoorIds) {
  if (personIds.length === 0) return new Map();
  const placeholders = generatePlaceholders(personIds);
  const sql = `
    SELECT r.person_id, r.swip_card_rev_time, r.physical_id
    FROM baseacs.slot_card_records r
    WHERE r.person_id IN (${placeholders}) AND r.person_id != -1 AND r.is_deleted = false
    ORDER BY r.swip_card_rev_time DESC`;
  const allRecords = await externalDb.query(sql, personIds);
  const personRecords = new Map();
  personIds.forEach((id) =>
    personRecords.set(id, { lastEntry: null, lastExit: null }),
  );
  allRecords.forEach((record) => {
    const personId = record.person_id;
    if (personId === -1) return;
    const eventType = parseEventType(record, entryDoorIds, exitDoorIds);
    if (eventType === null) return;
    const pr = personRecords.get(personId);
    if (eventType === "entry" && !pr.lastEntry) pr.lastEntry = record;
    else if (eventType === "exit" && !pr.lastExit) pr.lastExit = record;
  });
  return personRecords;
}

async function batchGetHeadPics(personIds) {
  if (personIds.length === 0) return new Map();
  return handleNonCriticalError(
    async () => {
      const results = await yscpPersonService.getBatchPersonInfo(personIds, {
        includePicture: true,
      });
      const m = new Map();
      results.forEach((result) => {
        if (result.success && result.personInfo) {
          const personId = parseInt(result.personId, 10);
          const pictureUrl = result.picture
            ? `data:image/jpeg;base64,${result.picture}`
            : null;
          m.set(personId, {
            person_id: personId,
            standard_head_portrait: pictureUrl,
            thumbnail_head_portrait: pictureUrl,
          });
        }
      });
      return m;
    },
    "無法批次取得人員照片",
    new Map(),
    { personIds },
  );
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function formatTime(date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function generateRecordId(personId, timestamp) {
  return `${personId}-${new Date(timestamp).getTime()}`;
}

/**
 * 單一工地完整資料（統計 + 單位列表），供 getSites / getSiteStats 使用
 */
async function getSiteData(siteId, config) {
  const { personGroupIds, entryDoorIds, exitDoorIds } = config;
  if (personGroupIds.length === 0) {
    return { entryCount: 0, exitCount: 0, currentCount: 0, units: [] };
  }
  const personIds = await getPersonIdsByGroupIds(personGroupIds);
  if (personIds.length === 0) {
    return { entryCount: 0, exitCount: 0, currentCount: 0, units: [] };
  }
  const todayRecords = await getTodayRecordsOnly(personIds);
  const stats = calculateTodayStatsByPhysicalId(
    todayRecords,
    entryDoorIds,
    exitDoorIds,
  );
  const units = await getUnitsByGroupIds(
    personGroupIds,
    todayRecords,
    entryDoorIds,
    exitDoorIds,
  );
  return {
    entryCount: stats.entryCount,
    exitCount: stats.exitCount,
    currentCount: stats.currentCount,
    units,
  };
}

/**
 * 批次取得多個 YSCP 工地的資料（供 getSites 優化）
 */
async function getSitesData(locations, getPeopleCountingConfig) {
  const yscpLocations = locations.filter(
    (loc) => (getPeopleCountingConfig(loc).dataSource || "yscp") === "yscp",
  );
  if (yscpLocations.length === 0) return new Map();
  const siteDataMap = await batchGetSitesData(
    yscpLocations,
    getPeopleCountingConfig,
  );
  const result = new Map();
  for (const location of yscpLocations) {
    const locationId =
      typeof location.id === "string" ? Number(location.id) : location.id;
    const cfg = getPeopleCountingConfig(location);
    const data = siteDataMap.get(locationId);
    if (!data || cfg.personGroupIds.length === 0) continue;
    const stats = calculateTodayStatsByPhysicalId(
      data.records,
      cfg.entryDoorIds,
      cfg.exitDoorIds,
    );
    const units = await getUnitsByGroupIds(
      cfg.personGroupIds,
      data.records,
      cfg.entryDoorIds,
      cfg.exitDoorIds,
    );
    result.set(locationId, {
      entryCount: stats.entryCount,
      exitCount: stats.exitCount,
      currentCount: stats.currentCount,
      units,
    });
  }
  return result;
}

/**
 * 進出紀錄
 */
async function getSiteLogs(siteId, config, options = {}, context = {}) {
  const { entryDoorIds, exitDoorIds } = config;
  const generateRecordIdFn = context.generateRecordId || generateRecordId;
  const allowedPhysicalIds = [...new Set([...(entryDoorIds || []), ...(exitDoorIds || [])])]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (allowedPhysicalIds.length === 0) return { logs: [] };
  const records = await getRecordsByPhysicalIdsWithJoin(allowedPhysicalIds, {
    limit: options.limit ?? 50,
    offset: Math.max(0, Number(options.offset) || 0),
    unitId: options.unitId || null,
    startTime: options.startTime,
    endTime: options.endTime,
  });
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
  const doorNameMap =
    await peopleCountingSyncService.getDoorNamesByPhysicalIds(physicalIds);
  const logs = sortedRecords.map((record) => {
    const eventType = parseEventType(record, entryDoorIds, exitDoorIds);
    const physicalId =
      record.physical_id != null ? Number(record.physical_id) : null;
    const deviceName =
      physicalId != null ? (doorNameMap.get(physicalId) ?? "") : "";
    const resolvedType = eventType || "failed";
    return {
      id: generateRecordIdFn(record.person_id, record.swip_card_rev_time),
      personId: record.person_id,
      personName: record.person_name || "陌生人員",
      unitId: record.unit_id || null,
      unitName: record.unit_name || "",
      employeeId:
        record.employee_no != null && String(record.employee_no).trim() !== ""
          ? String(record.employee_no).trim()
          : null,
      eventType: resolvedType,
      eventLabel: yscpEventLabel(resolvedType),
      verifyMethod: null,
      timestamp: record.swip_card_rev_time,
      deviceScreenshotUrl: record.snap_pic_url || "",
      deviceName,
    };
  });
  return { logs };
}

/**
 * 單位人員列表
 */
async function getUnitPersonnel(unitId, siteId, config) {
  const { entryDoorIds, exitDoorIds } = config;
  const sql = `
    SELECT id, person_group_id, person_type, full_name, person_code
    FROM platform.person
    WHERE person_group_id = $1 AND person_type = 0
    ORDER BY id ASC`;
  const persons = await externalDb.query(sql, [unitId]);
  if (!persons || persons.length === 0) {
    return { personnel: [], entryCount: 0, exitCount: 0 };
  }
  const personIds = persons.map((p) => p.id);
  const headPicMap = await batchGetHeadPics(personIds);
  const todayRecords = await getTodayRecordsOnly(personIds);
  const todayStats = calculateTodayStatsByPhysicalId(
    todayRecords,
    entryDoorIds,
    exitDoorIds,
  );
  const { start: todayStart, end: todayEnd } = resolveStatsTimeRange({});
  const personTodayRecordsMap = new Map();
  todayRecords.forEach((record) => {
    if (record.person_id !== -1) {
      if (!personTodayRecordsMap.has(record.person_id))
        personTodayRecordsMap.set(record.person_id, []);
      personTodayRecordsMap.get(record.person_id).push(record);
    }
  });
  const latestRecords = await getLatestEntryExitRecords(
    personIds,
    entryDoorIds,
    exitDoorIds,
  );
  const personnel = persons.map((person) => {
    const headPic = headPicMap.get(person.id);
    const personTodayRecords = personTodayRecordsMap.get(person.id) || [];
    const latestRecord = latestRecords.get(person.id);
    let photoUrl;
    if (headPic?.standard_head_portrait)
      photoUrl = headPic.standard_head_portrait;
    else if (headPic?.thumbnail_head_portrait)
      photoUrl = headPic.thumbnail_head_portrait;
    else photoUrl = undefined;
    const lastEntryRecord = latestRecord?.lastEntry;
    const lastExitRecord = latestRecord?.lastExit;
    let lastEntryDate = null;
    let isTodayEntry = false;
    let entryTimeStr = null;
    let exitTimeStr = null;
    if (lastEntryRecord) {
      const entryTime = new Date(lastEntryRecord.swip_card_rev_time);
      isTodayEntry = entryTime >= todayStart && entryTime <= todayEnd;
      lastEntryDate = formatDate(entryTime);
      entryTimeStr = formatTime(entryTime);
    }
    if (isTodayEntry) {
      const entryTime = lastEntryRecord
        ? new Date(lastEntryRecord.swip_card_rev_time)
        : null;
      const todayExitRecord = personTodayRecords.find((r) => {
        const recordTime = new Date(r.swip_card_rev_time);
        const et = parseEventType(r, entryDoorIds, exitDoorIds);
        return et === "exit" && recordTime > entryTime;
      });
      if (todayExitRecord)
        exitTimeStr = formatTime(new Date(todayExitRecord.swip_card_rev_time));
    } else if (lastExitRecord) {
      exitTimeStr = formatTime(new Date(lastExitRecord.swip_card_rev_time));
    }
    const isInside =
      !!(lastEntryRecord && isTodayEntry && !exitTimeStr);
    return {
      id: person.id,
      employeeId:
        person.person_code != null && String(person.person_code).trim() !== ""
          ? String(person.person_code).trim()
          : "",
      name: person.full_name || "",
      photoUrl,
      isInside,
      lastEntryTime: lastEntryRecord
        ? lastEntryRecord.swip_card_rev_time
        : null,
      lastExitTime: lastExitRecord ? lastExitRecord.swip_card_rev_time : null,
      lastEntryDate,
      entryTime: entryTimeStr,
      exitTime: exitTimeStr,
      isTodayEntry,
    };
  });
  return {
    personnel,
    entryCount: todayStats.entryCount,
    exitCount: todayStats.exitCount,
  };
}

module.exports = {
  getSiteData,
  getSitesData,
  getSiteLogs,
  getUnitPersonnel,
};
