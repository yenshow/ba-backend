/**
 * 備份服務：雙層保留（歸檔 CSV／xlsx + 延後刪除 DB）、按日分檔
 * 人流／車輛三區塊報表寫 xlsx（雙工作表）；其餘仍為 CSV
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const db = require("../../database/db");
const { getBackupConfig } = require("./backupConfig");
const logger = require("../../utils/logger");
const {
  getRetentionCutoffs,
  groupRowsByDayKey,
  dayKeyToUtcRange,
  buildDayCsvFilename,
  buildDayXlsxFilename,
  toDayKey,
} = require("./backupDayUtils");
const {
  copyPicturesForRows,
  removeUploadPictures,
} = require("./backupEventAttachments");

const backupLogger = logger.createLogger("backupService");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

// --- 三區塊報表 → xlsx 雙工作表 ---

const sanitizeSheetName = (name) => {
  const raw = String(name || "明細").trim() || "明細";
  return raw.replace(/[\\/*?:\[\]]/g, "_").slice(0, 31);
};

const appendStackedSections = (sheet, sections, opts = {}) => {
  const includeSectionTitles = opts.includeSectionTitles !== false;
  let rowIdx = 1;
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    if (!section) continue;
    if (i > 0) rowIdx += 1;
    const { title, headers = [], rows = [] } = section;
    if (includeSectionTitles && title) {
      const titleRow = sheet.getRow(rowIdx);
      titleRow.getCell(1).value = title;
      titleRow.font = { bold: true };
      rowIdx += 1;
    }
    const headerRow = sheet.getRow(rowIdx);
    headers.forEach((header, col) => {
      headerRow.getCell(col + 1).value = header;
    });
    headerRow.font = { bold: true };
    rowIdx += 1;
    for (const row of rows) {
      const dataRow = sheet.getRow(rowIdx);
      headers.forEach((header, col) => {
        const v = row?.[header];
        dataRow.getCell(col + 1).value = v == null ? "" : String(v);
      });
      rowIdx += 1;
    }
  }
};

async function writeReportSectionsXlsx(filepath, sections) {
  const list = Array.isArray(sections) ? sections : [];
  const workbook = new ExcelJS.Workbook();
  const statsSheet = workbook.addWorksheet("統計");
  appendStackedSections(statsSheet, list.slice(0, 2), {
    includeSectionTitles: true,
  });
  const detailSection = list[2];
  if (detailSection) {
    const detailSheet = workbook.addWorksheet(
      sanitizeSheetName(detailSection.title || "明細"),
    );
    appendStackedSections(detailSheet, [detailSection], {
      includeSectionTitles: false,
    });
  }
  await workbook.xlsx.writeFile(filepath);
  return { filepath, size: fs.statSync(filepath).size };
}

// --- CSV 匯出 ---

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === "object") {
    return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
  }
  return `"${String(value).replace(/"/g, '""').replace(/,/g, ";")}"`;
}

function writeCsvFile(filepath, content) {
  fs.writeFileSync(filepath, content, "utf8");
  return { filepath, size: content.length };
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

function dayBackupCandidatePaths(outputDir, tableName, dayKey) {
  return [
    path.join(outputDir, buildDayXlsxFilename(tableName, dayKey)),
    path.join(outputDir, buildDayCsvFilename(tableName, dayKey)),
  ];
}

function hasValidDayBackup(outputDir, tableName, dayKey) {
  return dayBackupCandidatePaths(outputDir, tableName, dayKey).some((filepath) =>
    validateBackup(filepath),
  );
}

async function exportRowsToDayCsv(tableName, csvData, outputDir, dayKey) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  if (csvData && Array.isArray(csvData.sections)) {
    const filepath = path.join(
      outputDir,
      buildDayXlsxFilename(tableName, dayKey),
    );
    return writeReportSectionsXlsx(filepath, csvData.sections);
  }
  if (!csvData?.length) {
    return null;
  }
  const filepath = path.join(outputDir, buildDayCsvFilename(tableName, dayKey));
  return writeCsvFile(filepath, rowsToCsvContent(csvData));
}

function getCategoryDir(category) {
  return (
    getBackupConfig().directories[category] ||
    getBackupConfig().directories.root
  );
}

function validateBackup(filepath) {
  try {
    if (!filepath || !fs.existsSync(filepath)) {
      return false;
    }
    if (filepath.endsWith(".xlsx")) {
      return fs.statSync(filepath).size > 0;
    }
    if (filepath.endsWith(".csv")) {
      const content = fs.readFileSync(filepath, "utf8");
      return content.length > 0 && content.includes(",");
    }
    return false;
  } catch {
    return false;
  }
}

function getRetentionContext() {
  return getRetentionCutoffs(getBackupConfig().retention);
}

async function collectColdDayKeys({
  dateField,
  deleteBeforeDate,
  timezone,
  selectTimestampsSql,
  selectParams = [],
}) {
  const rows = await db.query(selectTimestampsSql, selectParams);
  const keys = new Set();
  for (const row of rows || []) {
    const ts = row[dateField];
    if (!ts) continue;
    if (new Date(ts) >= deleteBeforeDate) continue;
    const key = toDayKey(ts, timezone);
    if (key) keys.add(key);
  }
  return [...keys];
}

async function purgeColdDays({
  tableName,
  deleteBeforeDate,
  timezone,
  outputDir,
  dayKeys,
  buildDeleteDaySql,
  selectPicturesForDay,
}) {
  let deletedTotal = 0;

  for (const dayKey of dayKeys) {
    if (!hasValidDayBackup(outputDir, tableName, dayKey)) {
      continue;
    }

    const { start, end } = dayKeyToUtcRange(dayKey, timezone);
    if (start >= deleteBeforeDate) {
      continue;
    }

    let picturePaths = [];
    if (selectPicturesForDay) {
      try {
        picturePaths = await selectPicturesForDay(start, end);
      } catch (error) {
        backupLogger.warn("查詢冷資料附圖失敗", {
          tableName,
          dayKey,
          error: error?.message || String(error),
          module: "backupService",
        });
      }
    }

    try {
      const { sql, params } = buildDeleteDaySql(start, end, deleteBeforeDate);
      const result = await db.query(sql, params);
      const n = result?.rowCount ?? result?.length ?? 0;
      deletedTotal += n;
      if (n > 0 && picturePaths.length) {
        removeUploadPictures(picturePaths);
      }
    } catch (error) {
      backupLogger.error("冷資料按日刪除失敗", {
        tableName,
        dayKey,
        error: error?.message || String(error),
        module: "backupService",
      });
      throwApiError(
        C.BACKUP_DELETE_AFTER_SUCCESS_FAILED,
        `備份歸檔後刪除失敗: ${error.message}`,
        { statusCode: 500, details: error.message },
      );
    }
  }

  return deletedTotal;
}

/**
 * 雙層保留：按日匯出 CSV（溫資料仍留 DB），冷資料按日刪除
 */
async function backupTableDual(options) {
  const {
    tableName,
    rows,
    dateField,
    category = "default",
    csvTransform = null,
    attachmentSubdir = null,
    attachmentNamePrefix = "",
    picturePathField = "picture_path",
    selectColdTimestampsSql,
    selectColdParams = [],
    buildDeleteDaySql,
    selectPicturesForDay,
  } = options;

  const { archiveBeforeDate, deleteBeforeDate, timezone } = getRetentionContext();
  const outputDir = getCategoryDir(category);
  const archiveRows = (rows || []).filter(
    (r) => r?.[dateField] && new Date(r[dateField]) < archiveBeforeDate,
  );

  let exportedCount = 0;
  const files = [];
  const byDay = groupRowsByDayKey(archiveRows, dateField, timezone);

  for (const [dayKey, dayRows] of byDay.entries()) {
    if (hasValidDayBackup(outputDir, tableName, dayKey)) {
      continue;
    }

    let transformInput = dayRows;
    if (attachmentSubdir) {
      const backupPathMap = copyPicturesForRows(
        dayRows,
        attachmentSubdir,
        picturePathField,
        attachmentNamePrefix,
      );
      transformInput = dayRows.map((row) => {
        const url = row?.[picturePathField];
        const backupRel = url ? backupPathMap.get(url) : null;
        return backupRel
          ? { ...row, backup_picture_path: backupRel }
          : row;
      });
    }

    const csvData = csvTransform ? csvTransform(transformInput) : transformInput;
    try {
      const written = await exportRowsToDayCsv(
        tableName,
        csvData,
        outputDir,
        dayKey,
      );
      if (written?.filepath && validateBackup(written.filepath)) {
        exportedCount += dayRows.length;
        files.push(written.filepath);
      }
    } catch (error) {
      backupLogger.warn("按日 CSV 匯出失敗", {
        tableName,
        dayKey,
        error: error?.message || String(error),
        module: "backupService",
      });
    }
  }

  const coldDayKeys = await collectColdDayKeys({
    dateField,
    deleteBeforeDate,
    timezone,
    selectTimestampsSql: selectColdTimestampsSql,
    selectParams: selectColdParams,
  });

  const deletedCount = await purgeColdDays({
    tableName,
    deleteBeforeDate,
    timezone,
    outputDir,
    dayKeys: coldDayKeys,
    buildDeleteDaySql,
    selectPicturesForDay,
  });

  return {
    tableName,
    count: exportedCount,
    deletedCount,
    files: { csv: files },
    success: true,
  };
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

async function getIsapiAccessEventsForBackup(beforeDate) {
  const rows = await db.query(
    `SELECT id, device_id, device_ip, event_time, event_type, payload, file_count, picture_path
     FROM isapi_access_events
     WHERE event_time < $1
     ORDER BY event_time ASC`,
    [beforeDate],
  );
  return rows || [];
}

async function getIsapiFaceContrastEventsForBackup(beforeDate) {
  const rows = await db.query(
    `SELECT
       e.id,
       e.location_id,
       e.device_id,
       e.device_ip,
       e.channel_id,
       e.event_time,
       e.event_type,
       e.similarity,
       e.employee_no,
       e.person_name,
       e.pid,
       e.certificate_number,
       e.matched,
       e.payload,
       e.picture_path,
       l.name AS location_name,
       z.name AS zone_name
     FROM isapi_face_contrast_events e
     LEFT JOIN locations l ON e.location_id = l.id
     LEFT JOIN zones z ON l.zone_id = z.id
     WHERE e.event_time < $1
     ORDER BY e.event_time ASC`,
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

async function getLadderSdkEventsForBackup(beforeDate) {
  const rows = await db.query(
    `SELECT e.*,
            d.name AS device_name,
            p.employee_no,
            p.full_name AS person_name
     FROM ladder_sdk_events e
     LEFT JOIN devices d ON d.id = e.device_id
     LEFT JOIN person_ladder_cards plc ON plc.card_no = e.card_no
     LEFT JOIN persons p ON p.id = plc.person_id
     WHERE e.event_time < $1
     ORDER BY e.event_time ASC`,
    [beforeDate],
  );
  return rows || [];
}

async function getOperationalEventsForBackup(beforeDate) {
  const rows = await db.query(
    `SELECT e.*,
            d.name AS device_name,
            l.name AS location_name,
            z.name AS zone_name,
            u.username AS actor_username
     FROM operational_events e
     LEFT JOIN devices d ON d.id = e.device_id
     LEFT JOIN locations l ON l.id = e.location_id
     LEFT JOIN zones z ON z.id = l.zone_id
     LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.created_at < $1
     ORDER BY e.created_at ASC`,
    [beforeDate],
  );
  return rows || [];
}

module.exports = {
  backupTableDual,
  validateBackup,
  getRetentionContext,
  getPeopleCountingForBackup,
  getIsapiAccessEventsForBackup,
  getIsapiFaceContrastEventsForBackup,
  getIsapiPeopleCountingEventsForBackup,
  getVehiclePassagewayForBackup,
  getLadderSdkEventsForBackup,
  getOperationalEventsForBackup,
};
