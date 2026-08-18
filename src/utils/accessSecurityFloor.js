/**
 * 門禁保全樓層解析（與前端 app/utils/accessSecurityFloor.ts 對齊）
 */

const UNCLASSIFIED_FLOOR = "未分類";
const FLOOR_NAME_RE = /^(\d+F|B\d+F?|R\d+F?|RF|G)(?:[-_]?(.*))?$/i;

function parseAccessSecurityUnitName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { floor: UNCLASSIFIED_FLOOR, unitName: "" };
  const match = FLOOR_NAME_RE.exec(trimmed);
  if (!match) return { floor: UNCLASSIFIED_FLOOR, unitName: trimmed };
  const floor = String(match[1] || "").trim().toUpperCase();
  const rest = String(match[2] || "").trim();
  return {
    floor: floor || UNCLASSIFIED_FLOOR,
    unitName: rest || trimmed,
  };
}

function resolveAccessSecurityFloor(floorFromConfig, locationName) {
  const fromConfig = String(floorFromConfig || "").trim();
  if (fromConfig && fromConfig !== UNCLASSIFIED_FLOOR) return fromConfig;
  return parseAccessSecurityUnitName(locationName).floor || UNCLASSIFIED_FLOOR;
}

module.exports = {
  resolveAccessSecurityFloor,
};
