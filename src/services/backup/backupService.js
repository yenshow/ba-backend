/**
 * 備份服務：匯出 CSV、驗證後刪除 DB、清理過期歸檔檔
 */

const fs = require("fs");
const path = require("path");
const db = require("../../database/db");
const { getBackupConfig } = require("./backupConfig");
const logger = require("../../utils/logger");

const backupLogger = logger.createLogger("backupService");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

const DATE_FIELD_BY_TABLE = {
  environment_readings: "recorded_at",
  alerts: "created_at",
  people_counting_logs: "swip_card_rev_time",
  isapi_access_events: "event_time",
  isapi_people_counting_events: "event_time",
  vehicle_passageway_logs: "trigger_time",
  vehicle_passageway_logs_isapi: "trigger_time",
};

// --- CSV 匯出（與前端 backupStyle 一致：引號包格、逗號改分號）---

function writeCsvFile(filepath, content) {
  fs.writeFileSync(filepath, content, "utf8");
  return { filepath, size: content.length };
}

function formatDateForFilename(date, strategy = "date") {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  if (strategy === "date") {
    return `${year}-${month}-${day}`;
  }
  if (strategy === "daily") {
    return `${year}${month}${day}`;
  }

  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === "object") {
    return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
  }
  return `"${String(value).replace(/"/g, '""').replace(/,/g, ";")}"`;
}

function buildCsvFilename(tableName, namingStrategy, dateForFilename) {
  const dateToUse = dateForFilename || new Date();
  const timestamp = formatDateForFilename(dateToUse, namingStrategy);
  return namingStrategy === "daily"
    ? `${tableName}_archive_${timestamp}.csv`
    : `${tableName}_${timestamp}.csv`;
}

function rowsToCsvContent(rows) {
  const headers = Object.keys(rows[0]);
  const BOM = "\uFEFF";
  let csvContent = BOM + headers.join(",") + "\n";
  for (const row of rows) {
    const values = headers.map((header) => escapeCsvCell(row[header]));
    csvContent += values.join(",") + "\n";
  }
  return csvContent;
}

async function exportToCSV(
  tableName,
  data,
  outputDir,
  namingStrategy = "date",
  dateForFilename = null,
) {
  if (data.length === 0) {
    return null;
  }

  const filepath = path.join(
    outputDir,
    buildCsvFilename(tableName, namingStrategy, dateForFilename),
  );
  return writeCsvFile(filepath, rowsToCsvContent(data));
}

async function exportSectionsToCSV(
  tableName,
  sections,
  outputDir,
  namingStrategy = "date",
  dateForFilename = null,
) {
  const filepath = path.join(
    outputDir,
    buildCsvFilename(tableName, namingStrategy, dateForFilename),
  );

  const BOM = "\uFEFF";
  const parts = [];
  for (const { title, headers, rows } of sections) {
    parts.push(title);
    parts.push(headers.join(","));
    for (const row of rows) {
      const values = headers.map((h) => escapeCsvCell(row[h]));
      parts.push(values.join(","));
    }
  }
  return writeCsvFile(filepath, BOM + parts.join("\n"));
}

async function exportData(tableName, data, outputDir, options = {}) {
  const { namingStrategy = "date", csvTransform = null, dateForFilename = null } =
    options;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    const csvData = csvTransform ? csvTransform(data) : data;
    if (csvData && Array.isArray(csvData.sections)) {
      return {
        csv: await exportSectionsToCSV(
          tableName,
          csvData.sections,
          outputDir,
          namingStrategy,
          dateForFilename,
        ),
      };
    }
    return {
      csv: await exportToCSV(
        tableName,
        csvData,
        outputDir,
        namingStrategy,
        dateForFilename,
      ),
    };
  } catch (error) {
    backupLogger.error("匯出 CSV 失敗", {
      tableName,
      error: error?.message || String(error),
      module: "backupService",
    });
    return { csv: { error: error.message } };
  }
}

// --- 備份流程 ---

function getCategoryDir(category) {
  return (
    getBackupConfig().directories[category] ||
      getBackupConfig().directories.root
  );
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function resolveDateForFilename(tableName, data) {
  const dateField = DATE_FIELD_BY_TABLE[tableName];
  if (!dateField) {
    return null;
  }
  const dates = data.map((r) => r[dateField]).filter(Boolean);
  if (dates.length === 0) {
    return null;
  }
  return new Date(Math.min(...dates.map((d) => new Date(d).getTime())));
}

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
    [beforeDate],
  );
  return rows || [];
}

/**
 * @param {Date} beforeDate
 * @param {"yscp"|"isapi_camera"} dataSource
 */
async function getIsapiAccessEventsForBackup(beforeDate) {
  const rows = await db.query(
    `SELECT id, device_ip, event_time, event_type, payload, file_count, picture_path
     FROM isapi_access_events
     WHERE event_time < $1
     ORDER BY event_time ASC`,
    [beforeDate],
  );
  return rows || [];
}

async function getIsapiPeopleCountingEventsForBackup(beforeDate) {
  const rows = await db.query(
    `SELECT
       e.id,
       e.location_id,
       e.device_id,
       e.region_name,
       e.event_time,
       e.enter,
       e."exit",
       e.enter_delta,
       e.exit_delta,
       l.name AS location_name,
       z.name AS zone_name
     FROM isapi_people_counting_events e
     LEFT JOIN locations l ON e.location_id = l.id
     LEFT JOIN zones z ON l.zone_id = z.id
     WHERE e.event_time < $1
     ORDER BY e.event_time ASC`,
    [beforeDate],
  );
  return rows || [];
}

async function getVehiclePassagewayForBackup(beforeDate, dataSource = "yscp") {
  const isIsapi = dataSource === "isapi_camera";
  const rows = await db.query(
    `SELECT 
       trigger_time, lane_id, lane_name, license_plate, owner_name,
       allow_result, lane_type, vehicle_list_id, vehicle_list_name,
       zone_name, location_name, location_id, data_source,
       device_id, anpr_line, picture_path
     FROM vehicle_passageway_logs
     WHERE trigger_time < $1
       AND ${
         isIsapi
           ? "data_source = 'isapi_camera'"
           : "COALESCE(data_source, 'yscp') = 'yscp'"
       }
     ORDER BY trigger_time ASC`,
    [beforeDate],
  );
  return rows || [];
}

/**
 * 驗證 CSV 備份檔（非空且含欄位分隔）
 */
async function validateBackup(filepath) {
  try {
    if (!filepath?.endsWith(".csv") || !fs.existsSync(filepath)) {
      return false;
    }
    const content = fs.readFileSync(filepath, "utf8");
    return content.length > 0 && content.includes(",");
  } catch {
    return false;
  }
}

/**
 * 備份單一表：匯出 CSV → 驗證通過 → 可選刪除 DB
 */
async function backupTable(options) {
  const {
    tableName,
    data,
    deleteQuery,
    deleteParams,
    category = "default",
    deleteAfterBackup = false,
    mergeStrategy = "date",
    csvTransform = null,
  } = options;

  if (!data?.length) {
    return {
      tableName,
      count: 0,
      files: {},
      message: "沒有需要備份的資料",
    };
  }

  const outputDir = getCategoryDir(category);
  ensureDirectory(outputDir);

  const formatResults = await exportData(tableName, data, outputDir, {
    namingStrategy: mergeStrategy,
    csvTransform,
    dateForFilename: resolveDateForFilename(tableName, data),
  });

  const csvPath = formatResults.csv?.filepath;
  const exportError = formatResults.csv?.error;
  const exportResults = {};

  let exportOk = false;
  if (exportError) {
    backupLogger.warn("CSV 匯出失敗，略過刪除資料庫", {
      tableName,
      error: exportError,
      module: "backupService",
    });
  } else if (csvPath && (await validateBackup(csvPath))) {
    exportOk = true;
    exportResults.csv = csvPath;
  } else {
    backupLogger.warn("備份檔驗證失敗，略過刪除資料庫", {
      tableName,
      csvPath: csvPath || null,
      module: "backupService",
    });
  }

  let deletedCount = 0;
  const skippedDelete = deleteAfterBackup && !exportOk;

  if (deleteAfterBackup && exportOk) {
    if (!deleteQuery?.trim().toUpperCase().startsWith("DELETE")) {
      backupLogger.warn("deleteQuery 無效，略過刪除資料庫", {
        tableName,
        module: "backupService",
      });
    } else {
      try {
        const deleteResult = await db.query(deleteQuery, deleteParams);
        deletedCount = deleteResult?.rowCount ?? deleteResult?.length ?? 0;
      } catch (error) {
        backupLogger.error("刪除資料失敗", {
          tableName,
          error: error?.message || String(error),
          module: "backupService",
        });
        throwApiError(
          C.BACKUP_DELETE_AFTER_SUCCESS_FAILED,
          `備份成功但刪除資料失敗: ${error.message}`,
          { statusCode: 500, details: error.message },
        );
      }
    }
  }

  return {
    tableName,
    count: data.length,
    deletedCount,
    files: exportResults,
    exportOk,
    skippedDelete,
    success: exportOk && !skippedDelete,
  };
}

/**
 * 遞迴清理 backups/ 下過期檔案（含已停用的子目錄，依 mtime）
 */
async function purgeOldArchiveFiles(retentionDays = null) {
  const cfg = getBackupConfig();
  const retention = retentionDays ?? cfg.retention.backupFileDays;
  const root = cfg.directories.root;

  if (!fs.existsSync(root)) {
    return 0;
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retention);

  let deletedCount = 0;

  const deleteOldFiles = (dir) => {
    if (!fs.existsSync(dir)) {
      return;
    }

    for (const item of fs.readdirSync(dir)) {
      const itemPath = path.join(dir, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        deleteOldFiles(itemPath);
        try {
          if (fs.readdirSync(itemPath).length === 0) {
            fs.rmdirSync(itemPath);
          }
        } catch {
          // 忽略
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
  };

  try {
    deleteOldFiles(root);
    return deletedCount;
  } catch (error) {
    backupLogger.error("刪除舊備份檔案失敗", {
      retentionDays: retention,
      error: error?.message || String(error),
      module: "backupService",
    });
    throw error;
  }
}

module.exports = {
  backupTable,
  purgeOldArchiveFiles,
  validateBackup,
  getPeopleCountingForBackup,
  getIsapiAccessEventsForBackup,
  getIsapiPeopleCountingEventsForBackup,
  getVehiclePassagewayForBackup,
};
