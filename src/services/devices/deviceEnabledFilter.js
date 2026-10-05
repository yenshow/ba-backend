/**
 * 設備啟用過濾：背景訂閱／佈防／探測僅處理 enabled=true。
 */
const db = require("../../database/db");

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

/**
 * @param {unknown} deviceIds
 * @returns {Promise<number[]>}
 */
async function filterEnabledDeviceIds(deviceIds) {
  const ids = normalizeDeviceIds(deviceIds);
  if (ids.length === 0) return [];

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
  const rows = await db.query(
    `SELECT enabled FROM devices WHERE id = ? LIMIT 1`,
    [id],
  );
  return Boolean(rows?.[0]?.enabled);
}

module.exports = {
  filterEnabledDeviceIds,
  isDeviceEnabled,
};
