/**
 * 電梯事件紀錄表格欄位（地點 system_config.log_display_columns）
 * DB 建議只存可選欄位；讀取時 normalize 會補上 event、time。
 */

const ELEVATOR_LOG_COLUMN_KEYS = [
  "device_name",
  "name",
  "event",
  "floor",
  "time",
];

const ELEVATOR_LOG_COLUMN_LABELS = {
  device_name: "設備名稱",
  name: "姓名",
  event: "事件",
  floor: "樓層",
  time: "時間",
};

const REQUIRED_KEYS = new Set(["event", "time"]);

const TOGGLEABLE_KEYS = ELEVATOR_LOG_COLUMN_KEYS.filter(
  (k) => !REQUIRED_KEYS.has(k),
);

const DEFAULT_LOG_DISPLAY_COLUMNS = [...ELEVATOR_LOG_COLUMN_KEYS];

function normalizeLogDisplayColumns(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_LOG_DISPLAY_COLUMNS];
  }
  const allowed = new Set(ELEVATOR_LOG_COLUMN_KEYS);
  const seen = new Set();
  const out = [];
  for (const key of raw) {
    const k = String(key).trim();
    if (k === "card_no" || !allowed.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  if (out.length === 0) return [...DEFAULT_LOG_DISPLAY_COLUMNS];
  for (const k of REQUIRED_KEYS) {
    if (!seen.has(k)) out.push(k);
  }
  return ELEVATOR_LOG_COLUMN_KEYS.filter((k) => out.includes(k));
}

function toStoredLogDisplayColumns(normalized) {
  return normalized.filter((k) => !REQUIRED_KEYS.has(k));
}

module.exports = {
  ELEVATOR_LOG_COLUMN_KEYS,
  ELEVATOR_LOG_COLUMN_LABELS,
  TOGGLEABLE_KEYS,
  DEFAULT_LOG_DISPLAY_COLUMNS,
  normalizeLogDisplayColumns,
  toStoredLogDisplayColumns,
};
