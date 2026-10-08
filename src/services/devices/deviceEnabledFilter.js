/**
 * 設備啟用過濾（僅非 production／開發環境生效）。
 * 正式環境（NODE_ENV=production）略過 enabled，視所有設備為啟用。
 */
const db = require("../../database/db");
const config = require("../../config");

const parsePositiveInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

const normalizeDeviceIds = (deviceIds) => {
  const values = Array.isArray(deviceIds) ? deviceIds : [deviceIds];
  return [
    ...new Set(values.map((value) => parsePositiveInt(value)).filter(Boolean)),
  ];
};

/** 開發環境才啟用「設備停用」閘門（SSOT：config.deviceEnableFeature） */
const isDeviceEnableFeatureActive = () => Boolean(config.deviceEnableFeature);

/**
 * SQL 片段：正式環境回空字串；開發環境回 ` AND <col> IS TRUE`
 * @param {string} [columnRef="enabled"]
 */
const sqlAndEnabled = (columnRef = "enabled") => {
  if (!isDeviceEnableFeatureActive()) return "";
  return ` AND ${columnRef} IS TRUE`;
};

/**
 * @param {unknown} deviceIds
 * @returns {Promise<number[]>}
 */
async function filterEnabledDeviceIds(deviceIds) {
  const ids = normalizeDeviceIds(deviceIds);
  if (ids.length === 0) return [];
  if (!isDeviceEnableFeatureActive()) return ids;

  const rows = await db.query(
    `
      SELECT id
      FROM devices
      WHERE id = ANY(?::int[])
        AND enabled IS TRUE
      ORDER BY id ASC
    `,
    [ids],
  );

  return (rows || [])
    .map((r) => parsePositiveInt(r?.id))
    .filter(Boolean);
}

/**
 * @param {number|string|null|undefined} deviceId
 * @returns {Promise<boolean>}
 */
async function isDeviceEnabled(deviceId) {
  const id = parsePositiveInt(deviceId);
  if (!id) return false;
  if (!isDeviceEnableFeatureActive()) return true;
  const rows = await db.query(
    `SELECT enabled FROM devices WHERE id = ? LIMIT 1`,
    [id],
  );
  return Boolean(rows?.[0]?.enabled);
}

module.exports = {
  isDeviceEnableFeatureActive,
  sqlAndEnabled,
  filterEnabledDeviceIds,
  isDeviceEnabled,
};
