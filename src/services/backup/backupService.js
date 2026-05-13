/**
 * 統一備份服務核心
 * 提供統一的備份 API 和功能
 */

const db = require("../../database/db");
const backupConfig = require("./backupConfig");
const logger = require("../../utils/logger");

const backupLogger = logger.createLogger("backupService");

async function getPeopleCountingForBackup(beforeDate) {
  const rows = await db.query(
    `SELECT 
       p.*,
       l.name as location_name,
       z.name as zone_name
     FROM people_counting_logs p
     LEFT JOIN locations l ON p.location_id = l.id
     LEFT JOIN zones z ON l.zone_id = z.id
     WHERE p.swip_card_rev_time < $1
     ORDER BY p.swip_card_rev_time ASC`,
    [beforeDate]
  );
  return rows || [];
}

async function getVehiclePassagewayForBackup(beforeDate) {
  const rows = await db.query(
    `SELECT 
       trigger_time, lane_id, lane_name, license_plate, owner_name,
       allow_result, lane_type, vehicle_list_id, vehicle_list_name,
       zone_name, location_name, location_id
     FROM vehicle_passageway_logs
     WHERE trigger_time < $1
     ORDER BY trigger_time ASC`,
    [beforeDate]
  );
  return rows || [];
}

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
 * 取得表的備份目錄（僅 CSV，依 category 分資料夾）
 */
function getBackupDirectory(category = "default") {
  const dirMap = {
    alerts: backupConfig.directories.alerts,
    environmentReadings: backupConfig.directories.environmentReadings,
    environmentReadingsAggregated: backupConfig.directories.environmentReadingsAggregated,
    peopleCounting: backupConfig.directories.peopleCounting,
    vehicleAccess: backupConfig.directories.vehicleAccess,
    default: backupConfig.directories.root,
  };
  return dirMap[category] || dirMap.default;
}

/**
 * 備份單一表
 * @param {Object} options - 備份選項
 * @returns {Promise<Object>} 備份結果
 */
async function backupTable(options) {
  const {
    tableName,
    query = null,
    params = [],
    data: providedData = null,
    deleteQuery = null,
    deleteParams = null,
    category = "default",
    deleteAfterBackup = false,
    mergeStrategy = "date",
    compress = false,
    csvTransform = null,
  } = options;

  try {
    const outputDir = getBackupDirectory(category);
    ensureDirectory(outputDir);

    // 取得資料：使用提供的 data 或執行查詢
    const data = providedData !== null
      ? providedData
      : await db.query(query, params);

    if (!data || data.length === 0) {
      return {
        tableName,
        count: 0,
        files: {},
        message: "沒有需要備份的資料",
      };
    }

    // 匯出資料：檔名使用資料日期（非執行日期）
    const exportResults = {};
    const namingStrategy = mergeStrategy;
    const dateFieldMap = {
      environment_readings: "recorded_at",
      environment_readings_aggregated: "bucket_at",
      alerts: "created_at",
      people_counting_logs: "swip_card_rev_time",
      vehicle_passageway_logs: "trigger_time",
    };
    const dateField = dateFieldMap[tableName];
    let dateForFilename = null;
    if (dateField && data.length > 0) {
      const dates = data.map((r) => r[dateField]).filter(Boolean);
      if (dates.length > 0) {
        dateForFilename = new Date(Math.min(...dates.map((d) => new Date(d).getTime())));
      }
    }

    // 僅 CSV
    const formatResults = await exportData(
      tableName,
      data,
      ["csv"],
      outputDir,
      {
        namingStrategy,
        compress,
        csvTransform,
        dateForFilename,
      }
    );

    if (formatResults.csv && !formatResults.csv.error) {
      exportResults.csv = formatResults.csv.filepath;
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
          backupLogger.warn("無法自動生成刪除查詢，請提供 deleteQuery 選項", {
            tableName,
            module: "backupService",
          });
        } else {
          const deleteResult = await db.query(finalDeleteQuery, finalDeleteParams);
          deletedCount = deleteResult ? (deleteResult.rowCount || deleteResult.length || 0) : 0;
        }
      } catch (error) {
        backupLogger.error("刪除資料失敗", {
          tableName,
          error: error?.message || String(error),
          module: "backupService",
        });
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
    backupLogger.error("備份表失敗", {
      tableName,
      error: error?.message || String(error),
      module: "backupService",
    });
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
    compress = false,
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
      environmentReadings: backupConfig.directories.environmentReadings,
      environmentReadingsAggregated: backupConfig.directories.environmentReadingsAggregated,
      peopleCounting: backupConfig.directories.peopleCounting,
      vehicleAccess: backupConfig.directories.vehicleAccess,
      default: backupConfig.directories.root,
    };

    const baseDir = dirMap[category] || dirMap.default;
    const retention = retentionDays ?? backupConfig.retention.backupFileDays;

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
            backupLogger.warn("刪除備份檔案失敗", {
              itemPath,
              error: error?.message || String(error),
              module: "backupService",
            });
          }
        }
      }
    }

    deleteOldFiles(baseDir);

    return deletedCount;
  } catch (error) {
    backupLogger.error("刪除舊備份檔案失敗", {
      category,
      retentionDays: retentionDays ?? backupConfig.retention.backupFileDays,
      error: error?.message || String(error),
      module: "backupService",
    });
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
  getPeopleCountingForBackup,
  getVehiclePassagewayForBackup,
};

