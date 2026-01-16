/**
 * 備份格式處理模組
 * 處理不同格式的資料匯出（JSON、CSV 等）
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");

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
 * @param {string} strategy - 命名策略 ('timestamp' | 'daily')
 * @returns {string} 格式化後的日期字串
 */
function formatDateForFilename(date, strategy = "timestamp") {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  if (strategy === "daily") {
    return `${year}${month}${day}`;
  }

  // timestamp 策略
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * 匯出資料為 JSON 格式
 * @param {string} tableName - 表名稱
 * @param {Array} data - 要匯出的資料
 * @param {string} outputDir - 輸出目錄
 * @param {string} namingStrategy - 命名策略
 * @param {boolean} compress - 是否壓縮
 * @returns {Promise<{filepath: string, size: number}>} 備份檔案路徑和大小
 */
async function exportToJSON(tableName, data, outputDir, namingStrategy = "timestamp", compress = false) {
  if (data.length === 0) {
    return null;
  }

  const timestamp = formatDateForFilename(new Date(), namingStrategy);
  const filename = namingStrategy === "daily" 
    ? `${tableName}_archive_${timestamp}.json`
    : `${tableName}_${timestamp}.json`;
  const filepath = path.join(outputDir, filename);

  const jsonData = JSON.stringify(data, null, 2);
  const content = Buffer.from(jsonData, "utf8");
  return await writeFile(filepath, content, compress);
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
async function exportToCSV(tableName, data, outputDir, namingStrategy = "timestamp", compress = false) {
  if (data.length === 0) {
    return null;
  }

  const timestamp = formatDateForFilename(new Date(), namingStrategy);
  const filename = namingStrategy === "daily"
    ? `${tableName}_archive_${timestamp}.csv`
    : `${tableName}_${timestamp}.csv`;
  const filepath = path.join(outputDir, filename);

  // 取得欄位名稱
  const headers = Object.keys(data[0]);

  // 建立 CSV 內容
  let csvContent = headers.join(",") + "\n";

  data.forEach((row) => {
    const values = headers.map((header) => {
      const value = row[header];
      // 處理 JSON 欄位和特殊字符
      if (value === null || value === undefined) {
        return "";
      }
      if (typeof value === "object") {
        return JSON.stringify(value).replace(/"/g, '""');
      }
      return String(value).replace(/"/g, '""').replace(/,/g, ";");
    });
    csvContent += values.map((v) => `"${v}"`).join(",") + "\n";
  });

  const content = Buffer.from(csvContent, "utf8");
  return await writeFile(filepath, content, compress);
}

/**
 * 合併現有的 JSON 備份檔案（用於 daily 策略）
 * @param {string} filepath - 備份檔案路徑
 * @param {Array} newData - 要合併的新資料
 * @returns {Promise<{filepath: string, size: number}>} 備份檔案路徑和大小
 */
async function mergeJSONBackup(filepath, newData) {
  let existingData = [];

  // 如果檔案存在，讀取現有資料
  if (fs.existsSync(filepath)) {
    const content = fs.readFileSync(filepath, "utf8");
    existingData = JSON.parse(content);
  }

  // 合併資料
  const mergedData = [...existingData, ...newData];

  // 寫入檔案
  const jsonData = JSON.stringify(mergedData, null, 2);
  fs.writeFileSync(filepath, jsonData, "utf8");

  return {
    filepath,
    size: Buffer.from(jsonData, "utf8").length,
    compressed: false,
  };
}

/**
 * 匯出資料為指定格式
 * @param {string} tableName - 表名稱
 * @param {Array} data - 要匯出的資料
 * @param {Array<string>} formats - 要匯出的格式 ['json', 'csv']
 * @param {string} outputDir - 輸出目錄
 * @param {Object} options - 選項
 * @returns {Promise<Object>} 匯出結果
 */
async function exportData(tableName, data, formats = ["json"], outputDir, options = {}) {
  const {
    namingStrategy = "timestamp",
    compress = false,
    mergeDaily = false,
  } = options;

  const results = {};

  // 確保輸出目錄存在
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 處理每種格式
  for (const format of formats) {
    try {
      if (format === "json") {
        // 如果是 daily 策略且需要合併
        if (namingStrategy === "daily" && mergeDaily) {
          const timestamp = formatDateForFilename(new Date(), "daily");
          const filename = `${tableName}_archive_${timestamp}.json`;
          const filepath = path.join(outputDir, filename);
          results.json = await mergeJSONBackup(filepath, data);
        } else {
          results.json = await exportToJSON(tableName, data, outputDir, namingStrategy, compress);
        }
      } else if (format === "csv") {
        results.csv = await exportToCSV(tableName, data, outputDir, namingStrategy, compress);
      }
    } catch (error) {
      console.error(`[backupFormats] 匯出 ${format} 格式失敗:`, error);
      results[format] = { error: error.message };
    }
  }

  return results;
}

module.exports = {
  exportData,
  exportToJSON,
  exportToCSV,
  mergeJSONBackup,
  formatDateForFilename,
};

