/**
 * 車輛過車紀錄 → entry / exit（須 allow_result === 1）
 */

function parseLaneId(value) {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * ISAPI／無地點設定時：依 lane_info.lane_type（1 進 2 出）
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

/**
 * YSCP：優先依地點 entryLaneId／exitLaneId；無匹配時 fallback lane_type
 */
function createVehicleDirectionResolver(entryLaneId, exitLaneId) {
  const entry = parseLaneId(entryLaneId);
  const exit = parseLaneId(exitLaneId);

  return (record) => {
    if (record?.allow_result !== 1) return null;
    const laneId = parseLaneId(record.lane_id);
    if (laneId != null) {
      if (entry != null && laneId === entry) return "entry";
      if (exit != null && laneId === exit) return "exit";
    }
    return normalizeVehicleDirection(record);
  };
}

module.exports = {
  normalizeVehicleDirection,
  createVehicleDirectionResolver,
  parseLaneId,
};
