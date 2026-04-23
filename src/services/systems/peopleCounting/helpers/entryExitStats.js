/**
 * 人流進出統計共用邏輯（與備份 CSV、前端一致）
 * 供 YSCP provider、備份報表、監控等使用。
 */

/**
 * 依 physical_id 判斷進場/出場（YSCP 用）
 * @param {Object} record - 記錄，含 person_id, physical_id
 * @param {number[]} entryDoorIds - 入口設備 IDs（physical_id）
 * @param {number[]} exitDoorIds - 出口設備 IDs（physical_id）
 * @returns {string|null} "entry" | "exit" | null（null 表示失敗/未註冊）
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

/**
 * 排序記錄（按時間升序）
 */
function sortRecordsByTime(records) {
  return [...records].sort(
    (a, b) =>
      new Date(a.swip_card_rev_time).getTime() -
      new Date(b.swip_card_rev_time).getTime()
  );
}

/**
 * 進出場計數：同人連續同向只計一次，首筆為出場不計。
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
 */
function calculateTodayStatsByPhysicalId(records, entryDoorIds, exitDoorIds) {
  if (records.length === 0) return { entryCount: 0, exitCount: 0 };
  const sortedRecords = sortRecordsByTime(records);
  const getDirection = (r) => parseEventType(r, entryDoorIds, exitDoorIds);
  return countEntryExitFromSorted(sortedRecords, getDirection);
}

/**
 * 計算當前在場人數（基於 physical_id）：當日最後一筆為進場的人數。
 */
function calculateCurrentCount(records, entryDoorIds, exitDoorIds) {
  if (records.length === 0) return 0;
  const personStatus = new Map();
  const sortedRecords = sortRecordsByTime(records);
  sortedRecords.forEach((record) => {
    const personId = record.person_id;
    if (personId === -1) return;
    const eventType = parseEventType(record, entryDoorIds, exitDoorIds);
    if (eventType === null) return;
    const recordTime = new Date(record.swip_card_rev_time);
    const current = personStatus.get(personId);
    if (!current || recordTime > current.lastTime) {
      personStatus.set(personId, { lastEvent: eventType, lastTime: recordTime });
    }
  });
  let count = 0;
  personStatus.forEach((status) => {
    if (status.lastEvent === "entry") count++;
  });
  return count;
}

module.exports = {
  parseEventType,
  sortRecordsByTime,
  countEntryExitFromSorted,
  calculateTodayStatsByPhysicalId,
  calculateCurrentCount,
};
