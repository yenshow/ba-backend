/**
 * 人流進出統計（YSCP physical_id 等）
 */
const { computeTransitionStats } = require("../../entryExit/stats");

/**
 * 依 physical_id 判斷進場/出場（YSCP 用）
 */
function parseEventType(record, entryDoorIds, exitDoorIds) {
  if (record.person_id === -1) return null;
  const physicalId = record.physical_id;
  if (physicalId == null) return null;
  const pid = Number(physicalId);
  if (!Number.isFinite(pid)) return null;
  if (Array.isArray(entryDoorIds) && entryDoorIds.some((id) => Number(id) === pid))
    return "entry";
  if (Array.isArray(exitDoorIds) && exitDoorIds.some((id) => Number(id) === pid))
    return "exit";
  return null;
}

function sortRecordsByTime(records) {
  return [...records].sort(
    (a, b) =>
      new Date(a.swip_card_rev_time).getTime() -
      new Date(b.swip_card_rev_time).getTime(),
  );
}

function calculateTodayStatsByPhysicalId(records, entryDoorIds, exitDoorIds) {
  const sortedRecords = sortRecordsByTime(records);
  const getDirection = (r) => parseEventType(r, entryDoorIds, exitDoorIds);
  return computeTransitionStats(sortedRecords, {
    getKey: (r) => (r.person_id === -1 ? null : r.person_id),
    getDirection,
    getTime: (r) => r.swip_card_rev_time,
    sortByTime: false,
  });
}

function groupEventsByKey(events, getKey) {
  const map = new Map();
  for (const event of events || []) {
    const raw = getKey(event);
    if (raw == null || String(raw).trim() === "") continue;
    const key = String(raw).trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  return map;
}

function personnelPresenceFields(presence, { formatDate, formatTime }) {
  const entry = presence.lastEntryTime;
  const exit = presence.isInside ? null : presence.lastExitTime;
  return {
    isInside: presence.isInside,
    isTodayEntry: entry != null,
    lastEntryTime: entry ? entry.toISOString() : null,
    lastExitTime: presence.lastExitTime
      ? presence.lastExitTime.toISOString()
      : null,
    lastEntryDate: entry ? formatDate(entry) : null,
    entryTime: entry ? formatTime(entry) : null,
    exitTime: exit ? formatTime(exit) : null,
  };
}

const ISO_PERSONNEL_TIME_FORMAT = {
  formatDate: (d) => d.toISOString().slice(0, 10),
  formatTime: (d) => d.toTimeString().slice(0, 8),
};

function normalizeEmployeeNo(value) {
  return value != null ? String(value).trim() : "";
}

/** 從人員列舉工號（門禁授權名單篩選用） */
function employeeNosFromPersons(persons) {
  return new Set(
    (persons || [])
      .map((p) => normalizeEmployeeNo(p.employee_no))
      .filter(Boolean),
  );
}

/** 僅保留指定人員工號的事件（logs 須含 employeeId） */
function filterLogsByEmployeeNos(logs, personsOrSet) {
  const nos =
    personsOrSet instanceof Set
      ? personsOrSet
      : employeeNosFromPersons(personsOrSet);
  if (nos.size === 0) return [];
  return (logs || []).filter((log) =>
    nos.has(normalizeEmployeeNo(log.employeeId)),
  );
}

/** 依人員工號彙整各單位事件（group.list 元素須有 employee_no） */
function collectUnitLogs(group, logsByEmployeeNo) {
  return group.list.flatMap((p) => {
    const no = normalizeEmployeeNo(p.employee_no);
    return no ? logsByEmployeeNo.get(no) || [] : [];
  });
}

function filterRecordsByDoorIds(records, entryDoorIds, exitDoorIds) {
  const doorSet = new Set(
    [...(entryDoorIds || []), ...(exitDoorIds || [])]
      .map((id) => Number(id))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
  if (doorSet.size === 0) return records || [];
  return (records || []).filter((r) => {
    const pid = Number(r.physical_id);
    return Number.isFinite(pid) && doorSet.has(pid);
  });
}

module.exports = {
  parseEventType,
  sortRecordsByTime,
  calculateTodayStatsByPhysicalId,
  groupEventsByKey,
  personnelPresenceFields,
  ISO_PERSONNEL_TIME_FORMAT,
  normalizeEmployeeNo,
  employeeNosFromPersons,
  filterLogsByEmployeeNos,
  collectUnitLogs,
  filterRecordsByDoorIds,
};
