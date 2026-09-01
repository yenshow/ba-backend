/**
 * 營運設定（system_settings）：備份排程、ISAPI 設備校時。
 * 警報日界線固定 Asia/Taipei 00:00（不可經 Web 調整）。
 * Bootstrap（伺服器/JWT/主庫/MediaMTX/YSCP/功能開關）由 .env 管理（安裝精靈）。
 */

const settingsService = require("./settingsService");
const logger = require("../../utils/logger");
const fs = require("fs");
const path = require("path");
const { getBackupRootDir } = require("../../utils/baDataPaths");

const runtimeLogger = logger.createLogger("runtimeConfigService");

/** 警報日界線／營運日（寫死，不經 system_settings） */
const FIXED_ALERT_ROLLOVER_TZ = "Asia/Taipei";
const FIXED_ALERT_ROLLOVER_LOCAL_HOUR = 0;
const FIXED_ALERT_ROLLOVER_LOCAL_MINUTE = 0;

const RUNTIME_KEYS = [
  "BACKUP_ROOT_DIR",
  "BACKUP_ARCHIVE_AFTER_DAYS",
  "BACKUP_ONLINE_RETENTION_DAYS",
  "BACKUP_DAILY_LOCAL_HOUR",
  "BACKUP_DAILY_LOCAL_MINUTE",
  "ISAPI_TIME_SYNC_ENABLED",
  "ISAPI_TIME_SYNC_DAILY_LOCAL_HOUR",
  "ISAPI_TIME_SYNC_DAILY_LOCAL_MINUTE",
];

const RUNTIME_KEY_SET = new Set(RUNTIME_KEYS);

const BACKUP_KEYS = [
  "BACKUP_ROOT_DIR",
  "BACKUP_ARCHIVE_AFTER_DAYS",
  "BACKUP_ONLINE_RETENTION_DAYS",
  "BACKUP_DAILY_LOCAL_HOUR",
  "BACKUP_DAILY_LOCAL_MINUTE",
];

const ISAPI_TIME_SYNC_KEYS = [
  "ISAPI_TIME_SYNC_ENABLED",
  "ISAPI_TIME_SYNC_DAILY_LOCAL_HOUR",
  "ISAPI_TIME_SYNC_DAILY_LOCAL_MINUTE",
];

const buildDefaultBackupRootDir = () => getBackupRootDir();

const DEFAULTS = {
  BACKUP_ROOT_DIR: buildDefaultBackupRootDir(),
  BACKUP_ARCHIVE_AFTER_DAYS: "7",
  BACKUP_ONLINE_RETENTION_DAYS: "365",
  BACKUP_DAILY_LOCAL_HOUR: "0",
  BACKUP_DAILY_LOCAL_MINUTE: "0",
  ISAPI_TIME_SYNC_ENABLED: "true",
  ISAPI_TIME_SYNC_DAILY_LOCAL_HOUR: "3",
  ISAPI_TIME_SYNC_DAILY_LOCAL_MINUTE: "0",
};

/** @type {Record<string, string>} */
let cache = { ...DEFAULTS };

let initialized = false;

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseDailyLocalTime = (
  source,
  { hourKey, minuteKey, defaultHour, defaultMinute },
) => ({
  dailyLocalHour: Math.min(
    23,
    Math.max(0, toNumber(source[hourKey], defaultHour)),
  ),
  dailyLocalMinute: Math.min(
    59,
    Math.max(0, toNumber(source[minuteKey], defaultMinute)),
  ),
});

const validateDailyLocalTimeKeys = (merged, hourKey, minuteKey, label) => {
  for (const k of [hourKey, minuteKey]) {
    const raw = merged[k]?.trim() ?? "";
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n)) return `${label}時刻須為整數`;
    if (k.endsWith("HOUR") && (n < 0 || n > 23)) {
      return `${label}小時須為 0–23`;
    }
    if (k.endsWith("MINUTE") && (n < 0 || n > 59)) {
      return `${label}分鐘須為 0–59`;
    }
  }
  return null;
};

const validateBooleanString = (merged, key, label) => {
  const raw = String(merged[key] ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw !== "true" && raw !== "false") {
    return `${label}須為 true 或 false`;
  }
  return null;
};

const buildCacheFromMap = (map) => {
  const merged = { ...DEFAULTS, ...map };
  const next = { ...DEFAULTS };
  for (const key of RUNTIME_KEYS) {
    const v = merged[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      next[key] = String(v).trim();
    }
  }
  cache = next;
};

const getAlerts = () => ({
  linkageRevertOnResolve: true,
  dailyRolloverEnabled: true,
  dailyRolloverTimezone: FIXED_ALERT_ROLLOVER_TZ,
  dailyRolloverLocalHour: FIXED_ALERT_ROLLOVER_LOCAL_HOUR,
  dailyRolloverLocalMinute: FIXED_ALERT_ROLLOVER_LOCAL_MINUTE,
});

const getBackup = () => {
  const archiveAfterDays = Math.max(
    1,
    toNumber(cache.BACKUP_ARCHIVE_AFTER_DAYS, 7),
  );
  const onlineRetentionDays = Math.max(
    archiveAfterDays + 1,
    toNumber(cache.BACKUP_ONLINE_RETENTION_DAYS, 365),
  );
  return {
    rootDir: cache.BACKUP_ROOT_DIR || DEFAULTS.BACKUP_ROOT_DIR,
    retention: {
      archiveAfterDays,
      onlineRetentionDays,
    },
    scheduler: parseDailyLocalTime(cache, {
      hourKey: "BACKUP_DAILY_LOCAL_HOUR",
      minuteKey: "BACKUP_DAILY_LOCAL_MINUTE",
      defaultHour: 0,
      defaultMinute: 0,
    }),
  };
};

const getIsapiTimeSync = () => {
  const enabledRaw = String(cache.ISAPI_TIME_SYNC_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  return {
    enabled: enabledRaw !== "false",
    timezone: FIXED_ALERT_ROLLOVER_TZ,
    scheduler: parseDailyLocalTime(cache, {
      hourKey: "ISAPI_TIME_SYNC_DAILY_LOCAL_HOUR",
      minuteKey: "ISAPI_TIME_SYNC_DAILY_LOCAL_MINUTE",
      defaultHour: 3,
      defaultMinute: 0,
    }),
  };
};

const getValues = () => {
  const values = {};
  for (const key of RUNTIME_KEYS) {
    values[key] = cache[key] ?? DEFAULTS[key] ?? "";
  }
  return values;
};

async function loadFromDatabase() {
  const map = await settingsService.getSettingsByKeys(RUNTIME_KEYS);
  buildCacheFromMap(map);
}

async function init() {
  if (initialized) return;
  await loadFromDatabase();
  initialized = true;
  runtimeLogger.info("Runtime 設定已載入");
}

function validateValues(merged) {
  const positiveInt = (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && Number.isInteger(n) && n >= 1;
  };

  for (const k of ["BACKUP_ARCHIVE_AFTER_DAYS", "BACKUP_ONLINE_RETENTION_DAYS"]) {
    const raw = merged[k]?.trim() ?? "";
    if (raw && !positiveInt(raw)) return `${k} 須為大於 0 的整數`;
  }

  const archiveDays = toNumber(
    merged.BACKUP_ARCHIVE_AFTER_DAYS?.trim() || DEFAULTS.BACKUP_ARCHIVE_AFTER_DAYS,
    7,
  );
  const onlineDays = toNumber(
    merged.BACKUP_ONLINE_RETENTION_DAYS?.trim() ||
      DEFAULTS.BACKUP_ONLINE_RETENTION_DAYS,
    365,
  );
  if (onlineDays < archiveDays + 1) {
    return "線上資料保留天數須大於「逾此天數寫入備份檔」";
  }

  const backupTimeErr = validateDailyLocalTimeKeys(
    merged,
    "BACKUP_DAILY_LOCAL_HOUR",
    "BACKUP_DAILY_LOCAL_MINUTE",
    "備份",
  );
  if (backupTimeErr) return backupTimeErr;

  const isapiTimeErr = validateDailyLocalTimeKeys(
    merged,
    "ISAPI_TIME_SYNC_DAILY_LOCAL_HOUR",
    "ISAPI_TIME_SYNC_DAILY_LOCAL_MINUTE",
    "ISAPI 校時",
  );
  if (isapiTimeErr) return isapiTimeErr;

  const enabledErr = validateBooleanString(
    merged,
    "ISAPI_TIME_SYNC_ENABLED",
    "ISAPI 校時啟用",
  );
  if (enabledErr) return enabledErr;

  const rootDir = merged.BACKUP_ROOT_DIR?.trim() ?? "";
  if (rootDir) {
    if (!path.isAbsolute(rootDir)) {
      return "BACKUP_ROOT_DIR 必須為絕對路徑";
    }
    try {
      fs.mkdirSync(rootDir, { recursive: true });
    } catch (e) {
      return `BACKUP_ROOT_DIR 無法建立或不可寫入：${e?.message || String(e)}`;
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
    next[key] = val;
    if (next[key] === (cache[key] ?? "")) continue;

    changedKeys.push(key);
  }

  const err = validateValues(next);
  if (err) {
    const { throwApiError } = require("../../utils/apiErrors");
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
  onAlertsChange: async () => {},
  onBackupChange: async () => {},
  onIsapiTimeSyncChange: async () => {},
};

function registerApplyHooks(hooks) {
  applyHooks = { ...applyHooks, ...hooks };
}

const hasAny = (keys, set) => keys.some((k) => set.has(k));

async function applySideEffects(changedKeys) {
  const set = new Set(changedKeys);
  if (hasAny(BACKUP_KEYS, set)) await applyHooks.onBackupChange();
  if (hasAny(ISAPI_TIME_SYNC_KEYS, set)) await applyHooks.onIsapiTimeSyncChange();
}

module.exports = {
  init,
  getAlerts,
  getBackup,
  getIsapiTimeSync,
  getValues,
  updateBatch,
  registerApplyHooks,
  applySideEffects,
};
