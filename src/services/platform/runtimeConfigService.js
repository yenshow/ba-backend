/**
 * 營運設定（system_settings）：YSCP、警報日界線、備份排程。
 * Bootstrap（伺服器/JWT/主庫/MediaMTX/功能開關）仍由 .env 管理。
 */

const settingsService = require("./settingsService");
const logger = require("../../utils/logger");

const runtimeLogger = logger.createLogger("runtimeConfigService");

const RUNTIME_KEYS = [
  "YSCP_HOST",
  "YSCP_DB_PASSWORD",
  "YSCP_AK",
  "YSCP_SK",
  "ALERT_DAILY_ROLLOVER_TZ",
  "ALERT_DAILY_ROLLOVER_LOCAL_HOUR",
  "ALERT_DAILY_ROLLOVER_LOCAL_MINUTE",
  "BACKUP_DATABASE_CUTOFF_DAYS",
  "BACKUP_ARCHIVE_FILE_RETENTION_DAYS",
  "BACKUP_SCHEDULER_INTERVAL",
];

const RUNTIME_KEY_SET = new Set(RUNTIME_KEYS);

/** 空字串表示「不變更」 */
const SECRET_KEYS = new Set(["YSCP_DB_PASSWORD", "YSCP_AK", "YSCP_SK"]);

const YSCP_KEYS = ["YSCP_HOST", "YSCP_DB_PASSWORD", "YSCP_AK", "YSCP_SK"];

const ALERT_KEYS = [
  "ALERT_DAILY_ROLLOVER_TZ",
  "ALERT_DAILY_ROLLOVER_LOCAL_HOUR",
  "ALERT_DAILY_ROLLOVER_LOCAL_MINUTE",
];

const BACKUP_KEYS = [
  "BACKUP_DATABASE_CUTOFF_DAYS",
  "BACKUP_ARCHIVE_FILE_RETENTION_DAYS",
  "BACKUP_SCHEDULER_INTERVAL",
];

const DEFAULTS = {
  YSCP_HOST: "192.168.2.2",
  YSCP_DB_PASSWORD: "",
  YSCP_AK: "",
  YSCP_SK: "",
  ALERT_DAILY_ROLLOVER_TZ: "Asia/Taipei",
  ALERT_DAILY_ROLLOVER_LOCAL_HOUR: "0",
  ALERT_DAILY_ROLLOVER_LOCAL_MINUTE: "5",
  BACKUP_DATABASE_CUTOFF_DAYS: "30",
  BACKUP_ARCHIVE_FILE_RETENTION_DAYS: "365",
  BACKUP_SCHEDULER_INTERVAL: String(24 * 60 * 60 * 1000),
};

/** @type {Record<string, string>} */
let cache = { ...DEFAULTS };

let initialized = false;

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeYscpHost = (raw) =>
  String(raw ?? DEFAULTS.YSCP_HOST)
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .split(":")[0] || DEFAULTS.YSCP_HOST;

const buildCacheFromMap = (map) => {
  const next = { ...DEFAULTS };
  for (const key of RUNTIME_KEYS) {
    const v = map[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      next[key] = String(v).trim();
    }
  }
  cache = next;
};

const getYscp = () => {
  const host = normalizeYscpHost(cache.YSCP_HOST);
  return {
    host: `https://${host}`,
    hostRaw: host,
    accessKey: cache.YSCP_AK ?? "",
    secretKey: cache.YSCP_SK ?? "",
    apiVersion: "v1",
    rejectUnauthorized: false,
  };
};

const getExternalDatabase = () => {
  const host = normalizeYscpHost(cache.YSCP_HOST);
  return {
    host,
    port: 5432,
    user: "postgres",
    password: cache.YSCP_DB_PASSWORD ?? "",
    database: "cms",
    connectionLimit: 10,
  };
};

const getAlerts = () => ({
  linkageRevertOnResolve: true,
  dailyRolloverEnabled: true,
  dailyRolloverTimezone:
    cache.ALERT_DAILY_ROLLOVER_TZ || DEFAULTS.ALERT_DAILY_ROLLOVER_TZ,
  dailyRolloverLocalHour: Math.min(
    23,
    Math.max(0, toNumber(cache.ALERT_DAILY_ROLLOVER_LOCAL_HOUR, 0)),
  ),
  dailyRolloverLocalMinute: Math.min(
    59,
    Math.max(0, toNumber(cache.ALERT_DAILY_ROLLOVER_LOCAL_MINUTE, 5)),
  ),
});

const getBackup = () => ({
  retention: {
    databaseDays: Math.max(1, toNumber(cache.BACKUP_DATABASE_CUTOFF_DAYS, 30)),
    backupFileDays: Math.max(
      1,
      toNumber(cache.BACKUP_ARCHIVE_FILE_RETENTION_DAYS, 365),
    ),
  },
  scheduler: {
    interval: Math.max(
      1,
      toNumber(cache.BACKUP_SCHEDULER_INTERVAL, 24 * 60 * 60 * 1000),
    ),
  },
});

const getValues = () => {
  const values = {};
  for (const key of RUNTIME_KEYS) {
    values[key] = cache[key] ?? DEFAULTS[key] ?? "";
  }
  return values;
};

async function loadFromDatabase() {
  const map = await settingsService.getSettingsByKeys(RUNTIME_KEYS);
  buildCacheFromMap({ ...DEFAULTS, ...map });
}

async function init() {
  if (initialized) return;
  await loadFromDatabase();
  initialized = true;
  runtimeLogger.info("Runtime 設定已載入", {
    yscpHost: normalizeYscpHost(cache.YSCP_HOST),
  });
}

function validateValues(merged) {
  const positiveInt = (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && Number.isInteger(n) && n >= 1;
  };

  if (!merged.YSCP_HOST?.trim()) return "主機不可為空白";

  for (const k of [
    "BACKUP_DATABASE_CUTOFF_DAYS",
    "BACKUP_ARCHIVE_FILE_RETENTION_DAYS",
  ]) {
    const raw = merged[k]?.trim() ?? "";
    if (raw && !positiveInt(raw)) return `${k} 須為大於 0 的整數`;
  }
  const intervalRaw = merged.BACKUP_SCHEDULER_INTERVAL?.trim() ?? "";
  if (intervalRaw && !positiveInt(intervalRaw)) {
    return "BACKUP_SCHEDULER_INTERVAL 須為大於 0 的整數（毫秒）";
  }
  const h = merged.ALERT_DAILY_ROLLOVER_LOCAL_HOUR?.trim() ?? "";
  if (h) {
    const n = Number(h);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      return "ALERT_DAILY_ROLLOVER_LOCAL_HOUR 須為 0–23";
    }
  }
  const m = merged.ALERT_DAILY_ROLLOVER_LOCAL_MINUTE?.trim() ?? "";
  if (m) {
    const n = Number(m);
    if (!Number.isInteger(n) || n < 0 || n > 59) {
      return "ALERT_DAILY_ROLLOVER_LOCAL_MINUTE 須為 0–59";
    }
  }
  return null;
}

/**
 * @param {Record<string, string>} partial
 * @returns {Promise<{ changedKeys: string[] }>}
 */
async function updateBatch(partial) {
  const changedKeys = [];
  const next = { ...cache };

  for (const [key, raw] of Object.entries(partial)) {
    if (!RUNTIME_KEY_SET.has(key)) continue;

    const val = String(raw ?? "").trim();
    if (SECRET_KEYS.has(key) && val === "") continue;

    if (key === "YSCP_HOST") {
      next[key] = normalizeYscpHost(val);
    } else {
      next[key] = val;
    }
    if (next[key] === (cache[key] ?? "")) continue;

    changedKeys.push(key);
  }

  const err = validateValues(next);
  if (err) {
    const { throwApiError } = require("../../utils/apiErrorMeta");
    const C = require("../../utils/apiErrorCodes");
    throwApiError(C.VALIDATION_CUSTOM, err, { statusCode: 400 });
  }

  for (const key of changedKeys) {
    await settingsService.upsertSetting(key, next[key], "runtime 營運設定");
  }

  cache = next;
  return { changedKeys };
}

let applyHooks = {
  onYscpChange: async () => {},
  onAlertsChange: async () => {},
  onBackupChange: async () => {},
};

function registerApplyHooks(hooks) {
  applyHooks = { ...applyHooks, ...hooks };
}

const hasAny = (keys, set) => keys.some((k) => set.has(k));

async function applySideEffects(changedKeys) {
  const set = new Set(changedKeys);
  if (hasAny(YSCP_KEYS, set)) await applyHooks.onYscpChange();
  if (hasAny(ALERT_KEYS, set)) await applyHooks.onAlertsChange();
  if (hasAny(BACKUP_KEYS, set)) await applyHooks.onBackupChange();
}

module.exports = {
  init,
  getYscp,
  getExternalDatabase,
  getAlerts,
  getBackup,
  getValues,
  updateBatch,
  registerApplyHooks,
  applySideEffects,
};
