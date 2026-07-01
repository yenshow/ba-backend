/**
 * 門禁（access_control）人流統計 Provider
 * 實作 getSiteData、getSiteLogs、getUnitPersonnel；資料來源為本系統 persons、isapi_access_events。
 */

const db = require("../../../database/db");
const deviceService = require("../../devices/deviceService");
const personnelService = require("../../personnel/personnelService");
const logger = require("../../../utils/logger");
const {
  extractSubEventType,
  resolveAccessControlEvent,
  resolveVerifyMethodLabel,
} = require("../accessControlLogLabels");
const {
  computeTransitionStats,
  resolvePersonPresenceFromEvents,
} = require("../../entryExit/stats");
const {
  groupEventsByKey,
  personnelPresenceFields,
  ISO_PERSONNEL_TIME_FORMAT,
  collectUnitLogs,
  normalizeEmployeeNo,
} = require("../helpers/entryExitStats");
const {
  ENTRY_EXIT_MAX_RECORDS,
  resolveStatsTimeRange,
} = require("../../entryExit/resolveTimeOptions");
const { resolvePeopleCountingStatsTimeRange } = require("../peopleCountingConfig");

function accessControlLogDirection(log) {
  return log.eventType === "entry" || log.eventType === "exit"
    ? log.eventType
    : null;
}

function normalizeDeviceHost(host) {
  if (!host || typeof host !== "string") return "";
  const trimmed = host.trim();
  const m = trimmed.match(/^(?:https?:\/\/)?([^:/]+)/);
  return m ? m[1] : trimmed;
}

function statsFromAccessControlLogs(logs) {
  return computeTransitionStats(logs || [], {
    getKey: (log) => log.employeeId,
    getDirection: accessControlLogDirection,
    getTime: (log) => log.timestamp,
  });
}

const UNGROUPED_GROUP_ID = 0;
const UNGROUPED_GROUP_NAME = "未分組";

function groupPersonsByPersonGroup(persons) {
  const byGroupId = new Map();
  for (const p of persons || []) {
    const groupId =
      p.person_group_id != null && Number.isFinite(Number(p.person_group_id))
        ? Number(p.person_group_id)
        : UNGROUPED_GROUP_ID;
    const groupName =
      groupId === UNGROUPED_GROUP_ID
        ? UNGROUPED_GROUP_NAME
        : p.group_name || UNGROUPED_GROUP_NAME;
    if (!byGroupId.has(groupId)) {
      byGroupId.set(groupId, { id: groupId, name: groupName, list: [] });
    }
    byGroupId.get(groupId).list.push(p);
  }
  return [...byGroupId.values()].sort((a, b) => {
    if (a.id === UNGROUPED_GROUP_ID) return 1;
    if (b.id === UNGROUPED_GROUP_ID) return -1;
    return String(a.name).localeCompare(String(b.name), "zh-Hant");
  });
}

function resolvePhotoUrl(person) {
  const faceUrl = person.face_url != null ? String(person.face_url).trim() : "";
  if (faceUrl === "") return undefined;
  return faceUrl.startsWith("/") ? faceUrl : `/${faceUrl}`;
}

/**
 * 門禁地點進出紀錄：從 isapi_access_events 查詢
 */
async function getAccessControlSiteLogs(options = {}) {
  const {
    entryDeviceIds,
    exitDeviceIds,
    limit = 50,
    offset = 0,
    startTime: optStart,
    endTime: optEnd,
  } = options;

  const entryIds = Array.isArray(entryDeviceIds)
    ? entryDeviceIds
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const exitIds = Array.isArray(exitDeviceIds)
    ? exitDeviceIds
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (entryIds.length === 0 && exitIds.length === 0) return [];

  const entryIps = new Set();
  const exitIps = new Set();
  const allIps = new Set();
  const ipToDeviceName = new Map();

  const addDevice = async (deviceId, isEntry) => {
    try {
      const { device } = await deviceService.getDeviceById(deviceId);
      const host = device?.config?.host;
      const ip = normalizeDeviceHost(host);
      if (ip) {
        allIps.add(ip);
        ipToDeviceName.set(ip, device?.name || ip);
        if (isEntry) entryIps.add(ip);
        else exitIps.add(ip);
      }
    } catch (err) {
      logger.warn("取得門禁設備 IP 失敗，略過", {
        deviceId,
        error: err.message,
      });
    }
  };

  const entryIdSet = new Set(entryIds);
  for (const id of entryIdSet) await addDevice(id, true);
  for (const id of new Set(exitIds)) {
    if (!entryIdSet.has(id)) await addDevice(id, false);
  }
  const allIpsArray = [...allIps];
  if (allIpsArray.length === 0) return [];

  const { start, end } = resolveStatsTimeRange({
    startTime: optStart,
    endTime: optEnd,
  });
  const limitNum = Math.min(Math.max(Number(limit) || 50, 1), ENTRY_EXIT_MAX_RECORDS);
  const offsetNum = Math.max(Number(offset) || 0, 0);

  const placeholders = allIpsArray.map(() => "?").join(",");
  const params = [
    ...allIpsArray,
    start.toISOString(),
    end.toISOString(),
    limitNum,
    offsetNum,
  ];
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
  const employeeNos = [
    ...new Set(
      (rows || [])
        .map((r) =>
          getEmployeeNo(typeof r.payload === "object" ? r.payload : {}),
        )
        .filter(Boolean),
    ),
  ];

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
    const sub = extractSubEventType(payload);
    const { eventType, eventLabel } = resolveAccessControlEvent(
      sub,
      entryIps,
      exitIps,
      row.device_ip,
    );
    const verifyMethodLabel = resolveVerifyMethodLabel(payload);
    const employeeId = getEmployeeNo(payload);
    const personInfo = employeeId ? personByEmployeeNo.get(employeeId) : null;
    const devicePersonName =
      payload.personName != null ? String(payload.personName).trim() : "";
    return {
      id: `isapi-${row.id}`,
      personId: personInfo?.personId ?? null,
      personName: personInfo?.personName || devicePersonName || "—",
      unitId: personInfo?.unitId ?? null,
      unitName: personInfo?.unitName ?? "",
      employeeId: employeeId || null,
      eventType,
      eventLabel,
      verifyMethod: verifyMethodLabel,
      timestamp: row.event_time,
      deviceScreenshotUrl: row.picture_path || "",
      deviceName: ipToDeviceName.get(row.device_ip) || row.device_ip,
    };
  });
}

/** 營運日入口／出口設備上所有進出事件（統計與 logs 同範圍，不限授權名單） */
async function getTodaySiteLogs(config, options = {}) {
  const entryDeviceIds = Array.isArray(config.entryDeviceIds)
    ? config.entryDeviceIds
    : [];
  const exitDeviceIds = Array.isArray(config.exitDeviceIds)
    ? config.exitDeviceIds
    : [];
  if (entryDeviceIds.length === 0 && exitDeviceIds.length === 0) return [];

  const { start, end } = resolvePeopleCountingStatsTimeRange(
    {
      startTime: options.startTime,
      endTime: options.endTime,
    },
    config.statsResetAt,
  );
  return getAccessControlSiteLogs({
    entryDeviceIds,
    exitDeviceIds,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    limit: options.limit ?? ENTRY_EXIT_MAX_RECORDS,
    offset: options.offset ?? 0,
  });
}

function filterLogsForUnitEmployees(logs, persons) {
  const nos = new Set(
    (persons || [])
      .map((p) => normalizeEmployeeNo(p.employee_no))
      .filter(Boolean),
  );
  if (nos.size === 0) return [];
  return (logs || []).filter((log) =>
    nos.has(normalizeEmployeeNo(log.employeeId)),
  );
}

function buildPersonnelRows(list, logsByEmployeeNo) {
  return list.map((p) => {
    const no = normalizeEmployeeNo(p.employee_no);
    const presence = resolvePersonPresenceFromEvents(
      logsByEmployeeNo.get(no) || [],
      {
        getDirection: accessControlLogDirection,
        getTime: (log) => log.timestamp,
      },
    );
    return {
      id: p.id,
      unitId: p.person_group_id || 0,
      employeeId: no,
      name: p.full_name || p.employee_no || "",
      photoUrl: resolvePhotoUrl(p),
      ...personnelPresenceFields(presence, ISO_PERSONNEL_TIME_FORMAT),
    };
  });
}

/**
 * 單一工地完整資料（統計 + 單位列表）
 */
async function getSiteData(siteId, config) {
  const siteLogs = await getTodaySiteLogs(config);
  const siteStats = statsFromAccessControlLogs(siteLogs);
  let units = [];
  try {
    const persons =
      await personnelService.getPersonsWithAccessByLocationId(siteId);
    const grouped = groupPersonsByPersonGroup(persons);
    const logsByEmployeeNo = groupEventsByKey(
      siteLogs,
      (log) => log.employeeId,
    );
    units = grouped.map((group) => ({
      id: group.id,
      name: group.name,
      currentCount: statsFromAccessControlLogs(
        collectUnitLogs(group, logsByEmployeeNo),
      ).currentCount,
      totalCount: group.list.length,
    }));
  } catch (err) {
    logger.warn("取得門禁地點可進出人員失敗，顯示空單位", {
      locationId: siteId,
      error: err.message,
    });
  }
  return {
    entryCount: siteStats.entryCount,
    exitCount: siteStats.exitCount,
    currentCount: siteStats.currentCount,
    units,
  };
}

/**
 * 進出紀錄
 */
async function getSiteLogs(siteId, config, options = {}) {
  const accessControlLogs = await getAccessControlSiteLogs({
    entryDeviceIds: config.entryDeviceIds,
    exitDeviceIds: config.exitDeviceIds,
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
    startTime: options.startTime,
    endTime: options.endTime,
  });
  return { logs: accessControlLogs };
}

/**
 * 單位人員列表（門禁：unitId 為 person_group.id；0 表示未分組）
 */
async function getUnitPersonnel(unitId, siteId, config) {
  const persons =
    await personnelService.getPersonsWithAccessByLocationId(siteId);
  const grouped = groupPersonsByPersonGroup(persons);
  const match = grouped.find((g) => g.id === Number(unitId));
  if (!match) return { personnel: [], entryCount: 0, exitCount: 0 };

  const siteLogs = await getTodaySiteLogs(config);
  const unitLogs = filterLogsForUnitEmployees(siteLogs, match.list);
  const { entryCount, exitCount } = statsFromAccessControlLogs(unitLogs);
  const logsByEmployeeNo = groupEventsByKey(unitLogs, (log) => log.employeeId);
  const personnel = buildPersonnelRows(match.list, logsByEmployeeNo);
  return { personnel, entryCount, exitCount };
}

module.exports = {
  getSiteData,
  getSiteLogs,
  getUnitPersonnel,
};
