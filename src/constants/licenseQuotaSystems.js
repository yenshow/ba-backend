/**
 * 授權額度：Modbus／status_points 以「點」計數的 location_systems.system_type。
 * 契約：docs/30-contracts/license-authorization.md §3
 */

const MODBUS_POINT_SYSTEM_TYPES = [
  "lighting",
  "hvac",
  "air_circulation",
  "drainage",
  "power",
  "fire",
  "emergency_rescue",
  "smoke_alarm",
];

const MODBUS_POINT_SYSTEM_TYPE_SET = new Set(MODBUS_POINT_SYSTEM_TYPES);

module.exports = {
  MODBUS_POINT_SYSTEM_TYPES,
  MODBUS_POINT_SYSTEM_TYPE_SET,
};
