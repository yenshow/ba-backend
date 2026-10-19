/**
 * 地點統計顯示名稱（system_config.stat_labels）
 * - people_counting / vehicle_access：entry / exit / current
 * - roll_call：expected / present / absent
 */

const STAT_LABEL_MAX_LEN = 6;

const DEFAULT_PEOPLE_COUNTING_STAT_LABELS = Object.freeze({
  entry: "進場人數",
  exit: "出場人數",
  current: "在場人數",
});

const DEFAULT_VEHICLE_ACCESS_STAT_LABELS = Object.freeze({
  entry: "進場車輛",
  exit: "出場車輛",
  current: "在場車輛",
});

const DEFAULT_ROLL_CALL_STAT_LABELS = Object.freeze({
  expected: "應到人數",
  present: "實到人數",
  absent: "未到人數",
});

const ENTRY_EXIT_KEYS = ["entry", "exit", "current"];
const ROLL_CALL_KEYS = ["expected", "present", "absent"];

function trimLabel(raw) {
  if (raw == null) return "";
  return String(raw).trim();
}

function clipLabel(raw) {
  return trimLabel(raw).slice(0, STAT_LABEL_MAX_LEN);
}

/**
 * @param {object|null|undefined} raw
 * @param {readonly string[]} keys
 * @param {Record<string, string>} defaults
 */
function normalizeKeyedLabels(raw, keys, defaults) {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of keys) {
    const custom = clipLabel(src[key]);
    out[key] = custom || defaults[key];
  }
  return out;
}

/**
 * 僅保留非空自訂值；全空則 null；超長拋 STAT_LABELS_TOO_LONG
 * @param {object|null|undefined} raw
 * @param {readonly string[]} keys
 */
function toStoredKeyedLabels(raw, keys) {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  let any = false;
  for (const key of keys) {
    const v = trimLabel(src[key]);
    if (!v) continue;
    if (v.length > STAT_LABEL_MAX_LEN) {
      const err = new Error(`統計顯示名稱不可超過 ${STAT_LABEL_MAX_LEN} 字`);
      err.code = "STAT_LABELS_TOO_LONG";
      throw err;
    }
    out[key] = v;
    any = true;
  }
  return any ? out : null;
}

function normalizePeopleCountingStatLabels(raw) {
  return normalizeKeyedLabels(
    raw,
    ENTRY_EXIT_KEYS,
    DEFAULT_PEOPLE_COUNTING_STAT_LABELS,
  );
}

function normalizeVehicleAccessStatLabels(raw) {
  return normalizeKeyedLabels(
    raw,
    ENTRY_EXIT_KEYS,
    DEFAULT_VEHICLE_ACCESS_STAT_LABELS,
  );
}

function normalizeRollCallStatLabels(raw) {
  return normalizeKeyedLabels(
    raw,
    ROLL_CALL_KEYS,
    DEFAULT_ROLL_CALL_STAT_LABELS,
  );
}

/**
 * @param {object|null|undefined} apiConfig
 * @param {'people_counting'|'vehicle_access'|'roll_call'} systemType
 */
function toStoredStatLabelsFromApi(apiConfig, systemType) {
  const raw = apiConfig?.statLabels ?? apiConfig?.stat_labels ?? null;
  const keys =
    systemType === "roll_call" ? ROLL_CALL_KEYS : ENTRY_EXIT_KEYS;
  const stored = toStoredKeyedLabels(raw, keys);
  return stored || undefined;
}

/**
 * @param {Array<object|null|undefined>} labelList
 * @param {Record<string, string>} defaults
 * @param {readonly string[]} keys
 */
function resolveSharedStatLabels(labelList, defaults, keys) {
  const list = (labelList || []).filter(
    (x) => x && typeof x === "object" && !Array.isArray(x),
  );
  if (list.length === 0) return { ...defaults };
  const first = list[0];
  for (let i = 1; i < list.length; i += 1) {
    const cur = list[i];
    for (const key of keys) {
      if (String(first[key] || "") !== String(cur[key] || "")) {
        return { ...defaults };
      }
    }
  }
  const out = {};
  for (const key of keys) {
    out[key] = first[key] || defaults[key];
  }
  return out;
}

function resolveSharedPeopleCountingStatLabels(labelList) {
  return resolveSharedStatLabels(
    labelList,
    DEFAULT_PEOPLE_COUNTING_STAT_LABELS,
    ENTRY_EXIT_KEYS,
  );
}

function resolveSharedVehicleAccessStatLabels(labelList) {
  return resolveSharedStatLabels(
    labelList,
    DEFAULT_VEHICLE_ACCESS_STAT_LABELS,
    ENTRY_EXIT_KEYS,
  );
}

function resolveSharedRollCallStatLabels(labelList) {
  return resolveSharedStatLabels(
    labelList,
    DEFAULT_ROLL_CALL_STAT_LABELS,
    ROLL_CALL_KEYS,
  );
}

function entryExitReportHeaders(labels) {
  return {
    statsHeaders: ["日期", "區域-地點", labels.entry, labels.exit, labels.current],
    groupStatsHeaders: [
      "日期",
      "區域-地點",
      "群組",
      labels.entry,
      labels.exit,
      labels.current,
    ],
  };
}

function rollCallReportHeaders(labels) {
  return {
    statsHeaders: [
      "日期",
      "區域-地點",
      "規則",
      labels.expected,
      labels.present,
      labels.absent,
    ],
    groupStatsHeaders: [
      "日期",
      "區域-地點",
      "群組",
      labels.expected,
      labels.present,
      labels.absent,
    ],
  };
}

function mapEntryExitStatsRow(row, labels) {
  const base = {
    日期: row.date,
    "區域-地點": row.zoneLocation,
    [labels.entry]: String(row.entryCount ?? 0),
    [labels.exit]: String(row.exitCount ?? 0),
    [labels.current]: String(row.currentCount ?? 0),
  };
  if (row.groupName != null) {
    return { ...base, 群組: row.groupName };
  }
  return base;
}

async function loadNormalizedStatLabelsForSystemType(systemType) {
  const db = require("../../database/db");
  const rows = await db.query(
    `SELECT system_config FROM location_systems WHERE system_type = $1`,
    [systemType],
  );
  const normalize =
    systemType === "roll_call"
      ? normalizeRollCallStatLabels
      : systemType === "vehicle_access"
        ? normalizeVehicleAccessStatLabels
        : normalizePeopleCountingStatLabels;
  return (rows || []).map((r) => {
    let cfg = r.system_config;
    if (typeof cfg === "string") {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = {};
      }
    }
    return normalize(cfg?.stat_labels);
  });
}

module.exports = {
  STAT_LABEL_MAX_LEN,
  DEFAULT_PEOPLE_COUNTING_STAT_LABELS,
  DEFAULT_VEHICLE_ACCESS_STAT_LABELS,
  DEFAULT_ROLL_CALL_STAT_LABELS,
  ENTRY_EXIT_KEYS,
  ROLL_CALL_KEYS,
  trimLabel,
  normalizePeopleCountingStatLabels,
  normalizeVehicleAccessStatLabels,
  normalizeRollCallStatLabels,
  toStoredStatLabelsFromApi,
  toStoredKeyedLabels,
  resolveSharedPeopleCountingStatLabels,
  resolveSharedVehicleAccessStatLabels,
  resolveSharedRollCallStatLabels,
  entryExitReportHeaders,
  rollCallReportHeaders,
  mapEntryExitStatsRow,
  loadNormalizedStatLabelsForSystemType,
};
