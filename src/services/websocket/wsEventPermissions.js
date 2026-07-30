/**
 * WebSocket 事件 ↔ permission code 對照（SSOT）
 * 對齊 docs/20-architecture/page-map.shared.md
 */

const { LOCATION_TYPE_MODULE } = require("../../access/catalog");

/** @type {Record<string, string | string[]>} */
const EVENT_PERMISSION_CODES = {
  "environment:reading:new": "system.environment",
  "alert:new": "system.alert_log",
  "alert:updated": "system.alert_log",
  "alert:count": "system.alert_log",
  "alert:daily_rollover": "system.alert_log",
  "people-counting:access-control:event": "system.people_counting",
  "people-counting:isapi-camera:event": "system.people_counting",
  "people-counting:stats-reset": "system.people_counting",
  "yscp:event:acs": "system.people_counting",
  "yscp:event:vehicle": "system.vehicle_access",
  "vehicle-access:isapi-camera:event": "system.vehicle_access",
  "elevator:runtime:update": "system.elevator",
  "ladder-sdk:event": "system.elevator",
  "monitoring:device:status": "system.equipment_management",
  "monitoring:device:status:batch": "system.equipment_management",
  "device:created": "system.equipment_management",
  "device:updated": "system.equipment_management",
  "device:deleted": "system.equipment_management",
  "operational-event:new": "system.operational_log",
};

const normalizePermissionCodes = (codes) => {
  if (codes == null) return [];
  const list = Array.isArray(codes) ? codes : [codes];
  return list.filter((c) => typeof c === "string" && c.trim());
};

/**
 * @param {string} eventName
 * @param {string|string[]|null|undefined} overrideCodes - safeEmit options.permissionCodes
 */
function getEventPermissionCodes(eventName, overrideCodes) {
  if (overrideCodes !== undefined) {
    return normalizePermissionCodes(overrideCodes);
  }
  return normalizePermissionCodes(EVENT_PERMISSION_CODES[eventName]);
}

function getSnapshotSystemPermissionCode(systemKey) {
  if (!systemKey || typeof systemKey !== "string") return null;
  return LOCATION_TYPE_MODULE[systemKey] || null;
}

module.exports = {
  EVENT_PERMISSION_CODES,
  getEventPermissionCodes,
  getSnapshotSystemPermissionCode,
};
