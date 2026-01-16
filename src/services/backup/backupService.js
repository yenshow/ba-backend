/**
 * 統一備份服務核心
 * 提供統一的備份 API 和功能
 */

const db = require("../../database/db");
const backupConfig = require("./backupConfig");
const { exportData } = require("./backupFormats");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");

const gunzip = promisify(zlib.gunzip);

/**
 * 確保目錄存在
 * @param {string} dirPath - 目錄路徑
 */
function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 取得表的備份目錄
 * @param {string} tableName - 表名稱
 * @param {string} category - 備份類別 ('alerts', 'deviceLogs', 'cleanup', 'default')
 * @param {Array<string>} formats - 備份格式
 * @returns {Object} 備份目錄物件 {base, json?, csv?}
 */
function getBackupDirectory(tableName, category = "default", formats = null) {
  const dirMap = {
    alerts: backupConfig.directories.alerts,
    deviceLogs: backupConfig.directories.deviceLogs,
    cleanup: backupConfig.directories.cleanup,
    default: backupConfig.directories.root,
  };

  const baseDir = dirMap[category] || dirMap.default;
  const backupFormats = formats || backupConfig.formats[tableName] || backupConfig.formats.default;

  // 多種格式時，建立格式子目錄
  if (backupFormats.length > 1) {
    return {
      json: path.join(baseDir, "json"),
      csv: path.join(baseDir, "csv"),
      base: baseDir,
    };
  }

  return { base: baseDir };
}

/**
 * 備份單一表
 * @param {Object} options - 備份選項
 * @returns {Promise<Object>} 備份結果
 */
async function backupTable(options) {
  const {
    tableName,
    query,
    params = [],
    deleteQuery = null, // 可選的刪除查詢（如果與備份查詢不同）
    deleteParams = null, // 可選的刪除參數
    category = "default",
    formats = null,
    deleteAfterBackup = false,
    mergeStrategy = "timestamp", // 'timestamp' | 'daily'
    compress = backupConfig.compression.enabled,
  } = options;

  try {
    // 取得備份格式
    const backupFormats = formats || backupConfig.formats[tableName] || backupConfig.formats.default;

    // 取得備份目錄
    const dirs = getBackupDirectory(tableName, category, backupFormats);
    const outputDir = dirs.base;

    // 確保目錄存在
    ensureDirectory(outputDir);
    if (dirs.json) {
      ensureDirectory(dirs.json);
      ensureDirectory(dirs.csv);
    }

    // 查詢資料
    const data = await db.query(query, params);

    if (!data || data.length === 0) {
      return {
        tableName,
        count: 0,
        files: {},
        message: "沒有需要備份的資料",
      };
    }

    // 匯出資料
    const exportResults = {};
    const namingStrategy = mergeStrategy;

    // 根據格式匯出
    for (const format of backupFormats) {
      const formatDir = dirs[format] || outputDir;
      ensureDirectory(formatDir);

      const formatResults = await exportData(
        tableName,
        data,
        [format],
        formatDir,
        {
          namingStrategy,
          compress,
          mergeDaily: mergeStrategy === "daily" && format === "json",
        }
      );

      if (formatResults[format] && !formatResults[format].error) {
        exportResults[format] = formatResults[format].filepath;
      }
    }

    // 如果設定為備份後刪除
    let deletedCount = 0;
    if (deleteAfterBackup && data.length > 0) {
      try {
        // 使用提供的刪除查詢，或從備份查詢生成
        const finalDeleteQuery = deleteQuery || query
          .replace(/^SELECT\s+.*?\s+FROM\s+/i, "DELETE FROM ")
          .replace(/\s+ORDER\s+BY\s+.*$/i, "");
        
        const finalDeleteParams = deleteParams !== null ? deleteParams : params;
        
        // 確保是 DELETE 語句
        if (!finalDeleteQuery.trim().toUpperCase().startsWith("DELETE")) {
          console.warn(`[backupService] 無法自動生成刪除查詢，請提供 deleteQuery 選項`);
        } else {
          const deleteResult = await db.query(finalDeleteQuery, finalDeleteParams);
          deletedCount = deleteResult ? (deleteResult.rowCount || deleteResult.length || 0) : 0;
        }
      } catch (error) {
        console.error(`[backupService] 刪除資料失敗:`, error);
        throw new Error(`備份成功但刪除資料失敗: ${error.message}`);
      }
    }

    return {
      tableName,
      count: data.length,
      deletedCount,
      files: exportResults,
      success: true,
    };
  } catch (error) {
    console.error(`[backupService] 備份表 ${tableName} 失敗:`, error);
    throw error;
  }
}

/**
 * 備份多個表
 * @param {Object} options - 備份選項
 * @returns {Promise<Object>} 備份結果
 */
async function backupMultiple(options) {
  const {
    tables,
    deleteAfterBackup = false,
    compress = backupConfig.compression.enabled,
  } = options;

  const results = {
    success: [],
    failed: [],
    totalCount: 0,
    totalDeleted: 0,
  };

  for (const tableConfig of tables) {
    try {
      const result = await backupTable({
        ...tableConfig,
        deleteAfterBackup: tableConfig.deleteAfterBackup !== undefined 
          ? tableConfig.deleteAfterBackup 
          : deleteAfterBackup,
        compress,
      });

      results.success.push(result);
      results.totalCount += result.count || 0;
      results.totalDeleted += result.deletedCount || 0;
    } catch (error) {
      results.failed.push({
        tableName: tableConfig.tableName,
        error: error.message,
      });
    }
  }

  return results;
}

/**
 * 刪除超過保留期的備份檔案
 * @param {string} category - 備份類別
 * @param {number} retentionDays - 保留天數
 * @returns {Promise<number>} 刪除的檔案數量
 */
async function deleteOldBackups(category = "default", retentionDays = null) {
  try {
    const dirMap = {
      alerts: backupConfig.directories.alerts,
      deviceLogs: backupConfig.directories.deviceLogs,
      cleanup: backupConfig.directories.cleanup,
      default: backupConfig.directories.root,
    };

    const baseDir = dirMap[category] || dirMap.default;
    const retention = retentionDays || backupConfig.retention.backup[category] || backupConfig.retention.backup.alerts;

    if (!fs.existsSync(baseDir)) {
      return 0;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retention);

    let deletedCount = 0;

    // 遞迴刪除舊檔案
    function deleteOldFiles(dir) {
      if (!fs.existsSync(dir)) {
        return;
      }

      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = path.join(dir, item);
        const stats = fs.statSync(itemPath);

        if (stats.isDirectory()) {
          deleteOldFiles(itemPath);
          // 如果目錄為空，刪除目錄
          try {
            if (fs.readdirSync(itemPath).length === 0) {
              fs.rmdirSync(itemPath);
            }
          } catch (error) {
            // 忽略錯誤
          }
        } else if (stats.isFile() && stats.mtime < cutoffDate) {
          try {
            fs.unlinkSync(itemPath);
            deletedCount++;
          } catch (error) {
            console.error(`[backupService] 刪除備份檔案失敗 ${itemPath}:`, error);
          }
        }
      }
    }

    deleteOldFiles(baseDir);

    return deletedCount;
  } catch (error) {
    console.error(`[backupService] 刪除舊備份檔案失敗:`, error);
    throw error;
  }
}

/**
 * 驗證備份檔案完整性
 * @param {string} filepath - 備份檔案路徑
 * @returns {Promise<boolean>} 是否有效
 */
async function validateBackup(filepath) {
  try {
    if (!fs.existsSync(filepath)) {
      return false;
    }

    let content;

    // 如果是壓縮檔案，先解壓縮
    if (filepath.endsWith(".gz")) {
      const compressedContent = fs.readFileSync(filepath);
      const decompressed = await gunzip(compressedContent);
      content = decompressed.toString("utf8");
    } else {
      content = fs.readFileSync(filepath, "utf8");
    }
    
    // 檢查 JSON 格式
    if (filepath.endsWith(".json") || filepath.endsWith(".json.gz")) {
      try {
        const data = JSON.parse(content);
        return Array.isArray(data) || typeof data === "object";
      } catch (error) {
        return false;
      }
    }

    // CSV 格式基本檢查
    if (filepath.endsWith(".csv") || filepath.endsWith(".csv.gz")) {
      return content.length > 0 && content.includes(",");
    }

    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  backupTable,
  backupMultiple,
  deleteOldBackups,
  validateBackup,
  getBackupDirectory,
  ensureDirectory,
};

