const db = require("../database/db");
const logger = require("../utils/logger");

const settingsLogger = logger.createLogger("settingsService");

/**
 * 取得所有系統設定
 * @returns {Promise<Array>} 設定列表
 */
async function getAllSettings() {
	try {
		const result = await db.query(
			`SELECT id, key, value, description, created_at, updated_at 
			 FROM system_settings 
			 ORDER BY key ASC`
		);
		return result;
	} catch (error) {
		settingsLogger.error("取得所有設定失敗", {
			error: error?.message || String(error),
			module: "settingsService",
		});
		throw new Error("取得系統設定失敗");
	}
}

/**
 * 根據 key 取得單一設定
 * @param {string} key - 設定鍵名
 * @returns {Promise<Object|null>} 設定物件或 null
 */
async function getSettingByKey(key) {
	try {
		const result = await db.query(
			`SELECT id, key, value, description, created_at, updated_at 
			 FROM system_settings 
			 WHERE key = $1`,
			[key]
		);
		return result.length > 0 ? result[0] : null;
	} catch (error) {
		settingsLogger.error("取得設定失敗", {
			key,
			error: error?.message || String(error),
			module: "settingsService",
		});
		throw new Error(`取得系統設定失敗: ${key}`);
	}
}

/**
 * 取得多個設定的值（批量查詢）
 * @param {Array<string>} keys - 設定鍵名陣列
 * @returns {Promise<Object>} 鍵值對物件 { key: value }
 */
async function getSettingsByKeys(keys) {
	if (!Array.isArray(keys) || keys.length === 0) {
		return {};
	}

	try {
		const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
		const result = await db.query(
			`SELECT key, value 
			 FROM system_settings 
			 WHERE key IN (${placeholders})`,
			keys
		);

		const settingsMap = {};
		result.forEach((row) => {
			settingsMap[row.key] = row.value;
		});

		return settingsMap;
	} catch (error) {
		settingsLogger.error("批量取得設定失敗", {
			error: error?.message || String(error),
			module: "settingsService",
		});
		throw new Error("批量取得系統設定失敗");
	}
}

/**
 * 建立或更新設定（UPSERT）
 * @param {string} key - 設定鍵名
 * @param {string} value - 設定值
 * @param {string} [description] - 設定描述（可選）
 * @returns {Promise<Object>} 更新後的設定物件
 */
async function upsertSetting(key, value, description = null) {
	if (!key || typeof key !== "string") {
		throw new Error("設定鍵名為必填且必須為字串");
	}

	try {
		const result = await db.query(
			`INSERT INTO system_settings (key, value, description)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (key) 
			 DO UPDATE SET 
			   value = EXCLUDED.value,
			   description = COALESCE(EXCLUDED.description, system_settings.description),
			   updated_at = CURRENT_TIMESTAMP
			 RETURNING id, key, value, description, created_at, updated_at`,
			[key, value, description]
		);

		if (result.length === 0) {
			throw new Error("建立或更新設定失敗");
		}

		return result[0];
	} catch (error) {
		settingsLogger.error("建立或更新設定失敗", {
			key,
			error: error?.message || String(error),
			module: "settingsService",
		});
		throw new Error(`建立或更新系統設定失敗: ${key}`);
	}
}

/**
 * 更新設定值
 * @param {string} key - 設定鍵名
 * @param {string} value - 新的設定值
 * @returns {Promise<Object>} 更新後的設定物件
 */
async function updateSetting(key, value) {
	if (!key || typeof key !== "string") {
		throw new Error("設定鍵名為必填且必須為字串");
	}

	try {
		const result = await db.query(
			`UPDATE system_settings 
			 SET value = $1, updated_at = CURRENT_TIMESTAMP
			 WHERE key = $2
			 RETURNING id, key, value, description, created_at, updated_at`,
			[value, key]
		);

		if (result.length === 0) {
			throw new Error(`設定不存在: ${key}`);
		}

		return result[0];
	} catch (error) {
		settingsLogger.error("更新設定失敗", {
			key,
			error: error?.message || String(error),
			module: "settingsService",
		});
		throw new Error(`更新系統設定失敗: ${key}`);
	}
}

/**
 * 刪除設定
 * @param {string} key - 設定鍵名
 * @returns {Promise<boolean>} 是否成功刪除
 */
async function deleteSetting(key) {
	if (!key || typeof key !== "string") {
		throw new Error("設定鍵名為必填且必須為字串");
	}

	try {
		const result = await db.query(
			`DELETE FROM system_settings 
			 WHERE key = $1
			 RETURNING id`,
			[key]
		);

		return result.length > 0;
	} catch (error) {
		settingsLogger.error("刪除設定失敗", {
			key,
			error: error?.message || String(error),
			module: "settingsService",
		});
		throw new Error(`刪除系統設定失敗: ${key}`);
	}
}

module.exports = {
	getAllSettings,
	getSettingByKey,
	getSettingsByKeys,
	upsertSetting,
	updateSetting,
	deleteSetting
};
