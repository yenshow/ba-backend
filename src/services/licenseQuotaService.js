const db = require("../database/db");

/**
 * v1 quota 計數策略（避免先做 schema migration）：
 * - camera -> surveillance（依 devices.type_code）
 * - sensor -> environment
 * - access_control -> people_counting
 * - controller（lighting/hvac/air_circulation/drainage/power/fire/emergency_rescue/smoke_alarm）-> 以 location_systems 綁定為準（系統內 DISTINCT 去重）
 */
const DEVICE_TYPE_CODE_TO_FEATURE = {
  camera: "surveillance",
  sensor: "environment",
  access_control: "people_counting",
};

const CONTROLLER_SYSTEM_TYPES = new Set([
  "lighting",
  "hvac",
  "drainage",
  "power",
  "air_circulation",
  "fire",
  "emergency_rescue",
  "smoke_alarm",
]);

const normalizeFeatureKey = (v) => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
};

const countByDeviceTypeCode = async (typeCode) => {
  const rows = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM devices d
     WHERE d.type_code = ?`,
    [typeCode],
  );
  return Number(rows?.[0]?.count ?? 0);
};

const countControllersBySystemBinding = async (systemType) => {
  const rows = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM (
       SELECT DISTINCT
        (ls.system_config->'device_ids'->>0)::int AS device_id
       FROM location_systems ls
       WHERE ls.system_type = ?
         AND jsonb_array_length(COALESCE(ls.system_config->'device_ids', '[]'::jsonb)) > 0
     ) x
     INNER JOIN devices d ON d.id = x.device_id
     WHERE d.type_code = 'controller'`,
    [systemType],
  );
  return Number(rows?.[0]?.count ?? 0);
};

const getUsedDevicesCount = async (featureKey) => {
  const key = normalizeFeatureKey(featureKey);
  if (!key) return 0;

  // controller 類型（lighting/drainage/fire/emergency_rescue...）以系統綁定計數
  if (CONTROLLER_SYSTEM_TYPES.has(key)) {
    return await countControllersBySystemBinding(key);
  }

  // 先吃固定 mapping
  const mappedTypeCodes = Object.keys(DEVICE_TYPE_CODE_TO_FEATURE).filter(
    (code) => DEVICE_TYPE_CODE_TO_FEATURE[code] === key,
  );
  let total = 0;
  for (const code of mappedTypeCodes) {
    total += await countByDeviceTypeCode(code);
  }

  return total;
};

const getUsageMap = async (featureKeys) => {
  const keys = Array.isArray(featureKeys)
    ? featureKeys.map(normalizeFeatureKey).filter(Boolean)
    : [];
  const usage = {};
  for (const key of keys) {
    usage[key] = { usedDevices: await getUsedDevicesCount(key) };
  }
  return usage;
};

const resolveDeviceFeatureKey = ({ typeCode, systemType } = {}) => {
  const code = normalizeFeatureKey(typeCode);
  if (!code) return null;

  if (DEVICE_TYPE_CODE_TO_FEATURE[code]) return DEVICE_TYPE_CODE_TO_FEATURE[code];
  if (code === "controller") return normalizeFeatureKey(systemType);
  return null;
};

module.exports = {
  DEVICE_TYPE_CODE_TO_FEATURE,
  resolveDeviceFeatureKey,
  getUsedDevicesCount,
  getUsageMap,
};

