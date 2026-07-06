/**
 * 營運設定（system_settings）：備份排程。
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
];

const RUNTIME_KEY_SET = new Set(RUNTIME_KEYS);

const BACKUP_KEYS = [
  "BACKUP_ROOT_DIR",
  "BACKUP_ARCHIVE_AFTER_DAYS",
  "BACKUP_ONLINE_RETENTION_DAYS",
  "BACKUP_DAILY_LOCAL_HOUR",
  "BACKUP_DAILY_LOCAL_MINUTE",
];

const buildDefaultBackupRootDir = () => getBackupRootDir();

const DEFAULTS = {
  BACKUP_ROOT_DIR: buildDefaultBackupRootDir(),
  BACKUP_ARCHIVE_AFTER_DAYS: "7",
  BACKUP_ONLINE_RETENTION_DAYS: "365",
  BACKUP_DAILY_LOCAL_HOUR: "0",
  BACKUP_DAILY_LOCAL_MINUTE: "0",
};

/** @type {Record<string, string>} */
let cache = { ...DEFAULTS };

let initialized = false;

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
    scheduler: {
      dailyLocalHour: Math.min(
        23,
        Math.max(0, toNumber(cache.BACKUP_DAILY_LOCAL_HOUR, 0)),
      ),
      dailyLocalMinute: Math.min(
        59,
        Math.max(0, toNumber(cache.BACKUP_DAILY_LOCAL_MINUTE, 0)),
      ),
    },
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

  for (const k of ["BACKUP_DAILY_LOCAL_HOUR", "BACKUP_DAILY_LOCAL_MINUTE"]) {
    const raw = merged[k]?.trim() ?? "";
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n)) return `${k} 須為整數`;
    if (k.endsWith("HOUR") && (n < 0 || n > 23)) {
      return "BACKUP_DAILY_LOCAL_HOUR 須為 0–23";
    }
    if (k.endsWith("MINUTE") && (n < 0 || n > 59)) {
      return "BACKUP_DAILY_LOCAL_MINUTE 須為 0–59";
    }
  }

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
};

function registerApplyHooks(hooks) {
  applyHooks = { ...applyHooks, ...hooks };
}

const hasAny = (keys, set) => keys.some((k) => set.has(k));

async function applySideEffects(changedKeys) {
  const set = new Set(changedKeys);
  if (hasAny(BACKUP_KEYS, set)) await applyHooks.onBackupChange();
}

module.exports = {
  init,
  getAlerts,
  getBackup,
  getValues,
  updateBatch,
  registerApplyHooks,
  applySideEffects,
};
