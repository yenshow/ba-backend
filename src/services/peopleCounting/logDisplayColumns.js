/**
 * 人流進出紀錄表格欄位（地點 system_config.log_display_columns）
 * DB 建議只存可選欄位；讀取時 normalize 會補上 event、time。
 */

const PEOPLE_COUNTING_LOG_COLUMN_KEYS = [
  "screenshot",
  "device_name",
  "name",
  "verify_method",
  "event",
  "time",
];

const PEOPLE_COUNTING_LOG_COLUMN_LABELS = {
  screenshot: "設備截圖",
  device_name: "出入口名稱",
  name: "姓名",
  verify_method: "方式",
  event: "事件",
  time: "時間",
};

const REQUIRED_KEYS = new Set(["event", "time"]);

const TOGGLEABLE_KEYS = PEOPLE_COUNTING_LOG_COLUMN_KEYS.filter(
  (k) => !REQUIRED_KEYS.has(k),
);

const DEFAULT_LOG_DISPLAY_COLUMNS = [...PEOPLE_COUNTING_LOG_COLUMN_KEYS];

function normalizeLogDisplayColumns(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_LOG_DISPLAY_COLUMNS];
  }
  const allowed = new Set(PEOPLE_COUNTING_LOG_COLUMN_KEYS);
  const seen = new Set();
  const out = [];
  for (const key of raw) {
    const k = String(key).trim();
    if (!allowed.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  if (out.length === 0) return [...DEFAULT_LOG_DISPLAY_COLUMNS];
  for (const k of REQUIRED_KEYS) {
    if (!seen.has(k)) out.push(k);
  }
  return PEOPLE_COUNTING_LOG_COLUMN_KEYS.filter((k) => out.includes(k));
}

function toStoredLogDisplayColumns(normalized) {
  return normalized.filter((k) => !REQUIRED_KEYS.has(k));
}

module.exports = {
  PEOPLE_COUNTING_LOG_COLUMN_KEYS,
  PEOPLE_COUNTING_LOG_COLUMN_LABELS,
  TOGGLEABLE_KEYS,
  DEFAULT_LOG_DISPLAY_COLUMNS,
  normalizeLogDisplayColumns,
  toStoredLogDisplayColumns,
};
