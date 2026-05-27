/**
 * 車輛過車紀錄 → entry / exit（須 allow_result === 1）
 */

/**
 * @param {{ allow_result?: number, lane_type?: number|null }} record
 * @returns {'entry'|'exit'|null}
 */
function normalizeVehicleDirection(record) {
  if (record?.allow_result !== 1) return null;
  const lt = record.lane_type != null ? Number(record.lane_type) : null;
  if (lt === 1) return "entry";
  if (lt === 2) return "exit";
  return null;
}

module.exports = { normalizeVehicleDirection };
