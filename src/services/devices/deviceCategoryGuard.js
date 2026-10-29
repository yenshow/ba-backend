const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const uniquePositiveIds = (rawList) => {
  const ids = [];
  const seen = new Set();
  for (const raw of rawList || []) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    const i = Math.trunc(n);
    if (seen.has(i)) continue;
    seen.add(i);
    ids.push(i);
  }
  return ids;
};

/**
 * 確認設備皆為指定型號分類的攝影機。
 * @param {Function} query
 * @param {unknown[]} deviceIds
 * @param {string} categoryCode
 * @param {string} errorCode
 * @param {string} mismatchMessage
 */
const assertCamerasHaveCategory = async (
  query,
  deviceIds,
  categoryCode,
  errorCode,
  mismatchMessage,
) => {
  const ids = uniquePositiveIds(deviceIds);
  if (ids.length === 0) return;

  const rows = await query(
    `SELECT d.id, d.type_code, dm.category_code
     FROM devices d
     LEFT JOIN device_models dm ON dm.id = d.model_id
     WHERE d.id = ANY(?::int[])`,
    [ids],
  );
  const byId = new Map((rows || []).map((row) => [Number(row.id), row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      throwApiError(errorCode, `設備不存在：${id}`);
    }
    if (String(row.type_code || "").toLowerCase() !== "camera") {
      throwApiError(errorCode, `設備 ${id} 必須為攝影機`);
    }
    if (String(row.category_code || "").trim() !== categoryCode) {
      throwApiError(errorCode, mismatchMessage);
    }
  }
};

module.exports = {
  assertCamerasHaveCategory,
};
