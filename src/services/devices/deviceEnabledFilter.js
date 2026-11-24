/**
 * 設備啟用過濾（僅非 production／開發環境生效）。
 * 封存設備在所有環境都會排除。
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
 * SQL 片段：一律排除封存設備，開發環境再檢查 enabled。
 * @param {string} [columnRef="enabled"]
 */
const sqlAndEnabled = (columnRef = "enabled") => {
  const archiveColumn = columnRef.replace(/enabled$/, "archived_at");
  const enabled = isDeviceEnableFeatureActive() ? ` AND ${columnRef} IS TRUE` : "";
  return ` AND ${archiveColumn} IS NULL${enabled}`;
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
      WHERE id = ANY(?::int[])${sqlAndEnabled()}
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
    `SELECT id FROM devices WHERE id = ?${sqlAndEnabled()} LIMIT 1`,
    [id],
  );
  return Boolean(rows?.[0]);
}

module.exports = {
  isDeviceEnableFeatureActive,
  sqlAndEnabled,
  filterEnabledDeviceIds,
  isDeviceEnabled,
};
