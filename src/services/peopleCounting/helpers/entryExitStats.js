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

module.exports = {
  parseEventType,
  sortRecordsByTime,
  calculateTodayStatsByPhysicalId,
};
