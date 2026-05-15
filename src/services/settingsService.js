const db = require("../database/db");
const logger = require("../utils/logger");
const C = require("../utils/apiErrorCodes");
const { throwApiError, rethrowIfApiError } = require("../utils/apiErrorMeta");

const settingsLogger = logger.createLogger("settingsService");

async function runDb(fn, { code, message, logMessage, logExtra = {} }) {
  try {
    return await fn();
  } catch (error) {
    rethrowIfApiError(error);
    settingsLogger.error(logMessage, {
      error: error?.message || String(error),
      module: "settingsService",
      ...logExtra,
    });
    throwApiError(code, message, {
      statusCode: 500,
      details: error.message,
    });
  }
}

async function getAllSettings() {
  return runDb(
    () =>
      db.query(
        `SELECT id, key, value, description, created_at, updated_at 
			 FROM system_settings 
			 ORDER BY key ASC`,
      ),
    {
      code: C.SETTINGS_LIST_FAILED,
      message: "取得系統設定失敗",
      logMessage: "取得所有設定失敗",
    },
  );
}

async function getSettingByKey(key, options = {}) {
  return runDb(
    async () => {
      const result = await db.query(
        `SELECT id, key, value, description, created_at, updated_at 
			 FROM system_settings 
			 WHERE key = $1`,
        [key],
      );
      if (result.length > 0) {
        return result[0];
      }
      if (options.throwIfNotFound) {
        throwApiError(C.SETTINGS_KEY_NOT_FOUND, `設定不存在: ${key}`, {
          statusCode: 404,
          details: { key },
        });
      }
      return null;
    },
    {
      code: C.SETTINGS_GET_FAILED,
      message: `取得系統設定失敗: ${key}`,
      logMessage: "取得設定失敗",
      logExtra: { key },
    },
  );
}

async function getSettingsByKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    return {};
  }

  return runDb(
    async () => {
      const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
      const result = await db.query(
        `SELECT key, value 
			 FROM system_settings 
			 WHERE key IN (${placeholders})`,
        keys,
      );

      const settingsMap = {};
      result.forEach((row) => {
        settingsMap[row.key] = row.value;
      });
      return settingsMap;
    },
    {
      code: C.SETTINGS_BATCH_GET_FAILED,
      message: "批量取得系統設定失敗",
      logMessage: "批量取得設定失敗",
    },
  );
}

async function upsertSetting(key, value, description = null) {
  if (!key || typeof key !== "string") {
    throwApiError(C.SETTINGS_KEY_REQUIRED, "設定鍵名為必填且必須為字串");
  }

  return runDb(
    async () => {
      const result = await db.query(
        `INSERT INTO system_settings (key, value, description)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (key) 
			 DO UPDATE SET 
			   value = EXCLUDED.value,
			   description = COALESCE(EXCLUDED.description, system_settings.description),
			   updated_at = CURRENT_TIMESTAMP
			 RETURNING id, key, value, description, created_at, updated_at`,
        [key, value, description],
      );

      if (result.length === 0) {
        throwApiError(C.SETTINGS_UPSERT_FAILED, "建立或更新設定失敗", {
          statusCode: 500,
          details: { key },
        });
      }

      return result[0];
    },
    {
      code: C.SETTINGS_UPSERT_FAILED,
      message: `建立或更新系統設定失敗: ${key}`,
      logMessage: "建立或更新設定失敗",
      logExtra: { key },
    },
  );
}

async function updateSetting(key, value) {
  if (!key || typeof key !== "string") {
    throwApiError(C.SETTINGS_KEY_REQUIRED, "設定鍵名為必填且必須為字串");
  }

  return runDb(
    async () => {
      const result = await db.query(
        `UPDATE system_settings 
			 SET value = $1, updated_at = CURRENT_TIMESTAMP
			 WHERE key = $2
			 RETURNING id, key, value, description, created_at, updated_at`,
        [value, key],
      );

      if (result.length === 0) {
        throwApiError(C.SETTINGS_KEY_NOT_FOUND, `設定不存在: ${key}`, {
          statusCode: 404,
          details: { key },
        });
      }

      return result[0];
    },
    {
      code: C.SETTINGS_UPDATE_FAILED,
      message: `更新系統設定失敗: ${key}`,
      logMessage: "更新設定失敗",
      logExtra: { key },
    },
  );
}

async function deleteSetting(key) {
  if (!key || typeof key !== "string") {
    throwApiError(C.SETTINGS_KEY_REQUIRED, "設定鍵名為必填且必須為字串");
  }

  return runDb(
    () =>
      db.query(
        `DELETE FROM system_settings 
			 WHERE key = $1
			 RETURNING id`,
        [key],
      ).then((result) => result.length > 0),
    {
      code: C.SETTINGS_DELETE_FAILED,
      message: `刪除系統設定失敗: ${key}`,
      logMessage: "刪除設定失敗",
      logExtra: { key },
    },
  );
}

module.exports = {
  getAllSettings,
  getSettingByKey,
  getSettingsByKeys,
  upsertSetting,
  updateSetting,
  deleteSetting,
};
