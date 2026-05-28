/**
 * 車輛進出紀錄表格欄位（地點 system_config.log_display_columns）
 * DB 建議只存可選欄位；讀取時 normalize 會補上 pass_result、time。
 */

const COLUMN_KEYS = [
  "plate_image",
  "person_group",
  "license_plate",
  "lane",
  "owner_name",
  "pass_result",
  "time",
];

const REQUIRED_KEYS = new Set(["pass_result", "time"]);

function normalizeLogDisplayColumns(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...COLUMN_KEYS];
  }
  const allowed = new Set(COLUMN_KEYS);
  const seen = new Set();
  const out = [];
  for (const key of raw) {
    const k = String(key).trim();
    if (!allowed.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  if (out.length === 0) return [...COLUMN_KEYS];
  for (const k of REQUIRED_KEYS) {
    if (!seen.has(k)) out.push(k);
  }
  return COLUMN_KEYS.filter((k) => out.includes(k));
}

function toStoredLogDisplayColumns(normalized) {
  return normalized.filter((k) => !REQUIRED_KEYS.has(k));
}

module.exports = {
  normalizeLogDisplayColumns,
  toStoredLogDisplayColumns,
};
