/**
 * 備份格式處理模組（僅 CSV）
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const logger = require("../../utils/logger");

const backupLogger = logger.createLogger("backupFormats");

const gzip = promisify(zlib.gzip);

/**
 * 寫入檔案（支援壓縮）
 * @param {string} filepath - 檔案路徑
 * @param {Buffer} content - 檔案內容
 * @param {boolean} compress - 是否壓縮
 * @returns {Promise<{filepath: string, size: number, compressed: boolean}>}
 */
async function writeFile(filepath, content, compress = false) {
  if (compress) {
    const compressed = await gzip(content);
    const compressedPath = filepath + ".gz";
    fs.writeFileSync(compressedPath, compressed);
    return {
      filepath: compressedPath,
      size: compressed.length,
      compressed: true,
    };
  }

  fs.writeFileSync(filepath, content, "utf8");
  return {
    filepath,
    size: content.length,
    compressed: false,
  };
}

/**
 * 格式化日期為檔案名稱
 * @param {Date} date - 日期物件
 * @param {string} strategy - 命名策略 ('date' | 'timestamp' | 'daily')
 *   - date: 僅日期 YYYY-MM-DD（與前端匯出一致）
 *   - daily: YYYYMMDD
 *   - timestamp: YYYYMMDD_HHMMSS
 * @returns {string} 格式化後的日期字串
 */
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

/** 備份風格：每格加引號、逗號改分號（與前端 backupStyle 一致） */
function escapeCsvCell(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === "object") {
    return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
  }
  return `"${String(value).replace(/"/g, '""').replace(/,/g, ";")}"`;
}

/**
 * 匯出資料為 CSV 格式
 * @param {string} tableName - 表名稱
 * @param {Array} data - 要匯出的資料
 * @param {string} outputDir - 輸出目錄
 * @param {string} namingStrategy - 命名策略
 * @param {boolean} compress - 是否壓縮
 * @returns {Promise<{filepath: string, size: number}>} 備份檔案路徑和大小
 */
async function exportToCSV(
  tableName,
  data,
  outputDir,
  namingStrategy = "date",
  compress = false,
  dateForFilename = null,
) {
  if (data.length === 0) {
    return null;
  }

  const dateToUse = dateForFilename || new Date();
  const timestamp = formatDateForFilename(dateToUse, namingStrategy);
  const filename =
    namingStrategy === "daily"
      ? `${tableName}_archive_${timestamp}.csv`
      : `${tableName}_${timestamp}.csv`;
  const filepath = path.join(outputDir, filename);

  const headers = Object.keys(data[0]);
  const BOM = "\uFEFF";
  let csvContent = BOM + headers.join(",") + "\n";

  data.forEach((row) => {
    const values = headers.map((header) => escapeCsvCell(row[header]));
    csvContent += values.join(",") + "\n";
  });

  const content = Buffer.from(csvContent, "utf8");
  return await writeFile(filepath, content, compress);
}

/**
 * 匯出多段 CSV（用於人流統計：進出統計 + 進出紀錄）
 * @param {string} tableName - 表名稱
 * @param {Array<{ title: string, headers: string[], rows: Object[] }>} sections - 各段標題、欄位、資料列
 * @param {string} outputDir - 輸出目錄
 * @param {string} namingStrategy - 命名策略
 * @param {boolean} compress - 是否壓縮
 * @param {Date} dateForFilename - 檔名用日期
 */
async function exportSectionsToCSV(
  tableName,
  sections,
  outputDir,
  namingStrategy = "date",
  compress = false,
  dateForFilename = null,
) {
  const dateToUse = dateForFilename || new Date();
  const timestamp = formatDateForFilename(dateToUse, namingStrategy);
  const filename =
    namingStrategy === "daily"
      ? `${tableName}_archive_${timestamp}.csv`
      : `${tableName}_${timestamp}.csv`;
  const filepath = path.join(outputDir, filename);

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
  const csvContent = BOM + parts.join("\n");
  const content = Buffer.from(csvContent, "utf8");
  return await writeFile(filepath, content, compress);
}

/**
 * 匯出資料為指定格式
 * @param {string} tableName - 表名稱
 * @param {Array} data - 要匯出的資料
 * @param {Array<string>} formats - 要匯出的格式（目前僅支援 'csv'）
 * @param {string} outputDir - 輸出目錄
 * @param {Object} options - 選項
 * @param {Function} [options.csvTransform] - 可選，將資料轉換後再匯出 CSV（用於與前端格式一致）
 * @returns {Promise<Object>} 匯出結果
 */
async function exportData(
  tableName,
  data,
  formats = ["csv"],
  outputDir,
  options = {},
) {
  const { namingStrategy = "date", compress = false, csvTransform = null, dateForFilename = null } = options;
  const results = {};

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const format of formats) {
    if (format !== "csv") continue;
    try {
      const csvData = csvTransform ? csvTransform(data) : data;
      if (csvData && Array.isArray(csvData.sections)) {
        results.csv = await exportSectionsToCSV(
          tableName,
          csvData.sections,
          outputDir,
          namingStrategy,
          compress,
          dateForFilename,
        );
      } else {
        results.csv = await exportToCSV(
          tableName,
          csvData,
          outputDir,
          namingStrategy,
          compress,
          dateForFilename,
        );
      }
    } catch (error) {
      backupLogger.error("匯出 CSV 失敗", {
        tableName,
        error: error?.message || String(error),
        module: "backupFormats",
      });
      results.csv = { error: error.message };
    }
  }

  return results;
}

module.exports = {
  exportData,
  exportToCSV,
  formatDateForFilename,
};
