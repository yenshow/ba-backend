/**
 * controller 類系統綁定設備提取（License 配額、綁定時 quota 檢查）
 * - elevator：ladder_device.device_id（梯控 HCNetSDK）
 * - 其餘 controller 系統：system_config.device_ids[0]
 */

const parsePositiveInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

const getPrimaryControllerDeviceId = (systemType, systemConfig) => {
  const config = systemConfig && typeof systemConfig === "object" ? systemConfig : {};
  if (systemType === "elevator") {
    return parsePositiveInt(config.ladder_device?.device_id);
  }
  const ids = config.device_ids;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return parsePositiveInt(ids[0]);
};

/** SQL：從 location_systems 提取 DISTINCT controller device_id（參數 $1 = system_type） */
const CONTROLLER_DEVICE_ID_SQL = `
  SELECT DISTINCT device_id
  FROM (
    SELECT
      CASE
        WHEN ls.system_type = 'elevator' THEN (ls.system_config->'ladder_device'->>'device_id')::int
        ELSE (ls.system_config->'device_ids'->>0)::int
      END AS device_id
    FROM location_systems ls
    WHERE ls.system_type = $1
  ) x
  WHERE device_id IS NOT NULL
`;

module.exports = {
  getPrimaryControllerDeviceId,
  CONTROLLER_DEVICE_ID_SQL,
};
