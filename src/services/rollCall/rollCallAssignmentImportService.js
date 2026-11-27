/**
 * 時段簽到排班 Excel：工號｜姓名｜每日欄（表頭＝星期＋日期）
 * 相容舊檔：工號｜姓名｜週起始｜一…日
 */
const ExcelJS = require("exceljs");
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const {
  weekDatesFromMonday,
  replaceAssignments,
  listAssignments,
} = require("./rollCallAssignmentService");
const {
  addDaysYmd,
  addMonthsYmd,
  mondayOfYmd,
  taipeiParts,
  formatTime,
} = require("./rollCallWindow");

const DAY_HEADERS = ["一", "二", "三", "四", "五", "六", "日"];
const OFF_TOKENS = new Set(["", "休", "排休", "off", "OFF", "休息", "-"]);

/** 與前端 `rollCallShiftColors.ts` 對齊（hex 不含 #） */
const SHIFT_PALETTE = [
  { bg: "DBEAFE", text: "1E3A5F" },
  { bg: "D1FAE5", text: "14532D" },
  { bg: "FEF3C7", text: "78350F" },
  { bg: "E0E7FF", text: "312E81" },
  { bg: "FCE7F3", text: "831843" },
  { bg: "CFFAFE", text: "164E63" },
  { bg: "EDE9FE", text: "4C1D95" },
  { bg: "FFEDD5", text: "7C2D12" },
];
const OFF_COLOR = { bg: "E5E7EB", text: "4B5563" };

const HEADER_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE8EEF5" },
};
const META_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFF3F4F6" },
};
const WEEKEND_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFF7ED" },
};

const solidFill = (hexRgb) => ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: `FF${hexRgb}` },
});

const shiftColorAtIndex = (index) => {
  if (!SHIFT_PALETTE.length) return OFF_COLOR;
  const i = ((index % SHIFT_PALETTE.length) + SHIFT_PALETTE.length) % SHIFT_PALETTE.length;
  return SHIFT_PALETTE[i];
};

/** @param {string} name @param {Map<string, number>} ruleNameToIndex */
const colorForShiftName = (name, ruleNameToIndex) => {
  const label = String(name || "").trim();
  if (!label || OFF_TOKENS.has(label)) return OFF_COLOR;
  const index = ruleNameToIndex.get(label);
  if (index == null) return OFF_COLOR;
  return shiftColorAtIndex(index);
};

const applyShiftCellStyle = (cell, name, ruleNameToIndex) => {
  const color = colorForShiftName(name, ruleNameToIndex);
  cell.fill = solidFill(color.bg);
  cell.font = { color: { argb: `FF${color.text}` } };
};

const cellValueToString = (value) => {
  if (value == null || value === "") return "";
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || "").join("");
    }
    if (value.result !== undefined) return cellValueToString(value.result);
    if (value.text != null) return String(value.text);
  }
  return String(value).trim();
};

const normalizeHeader = (value) => String(value || "").trim();

/** 表頭是否對應某曜日（純「一」或舊檔「一 11-02」） */
const isDayHeaderMatch = (header, day) => {
  const h = normalizeHeader(header);
  if (!h || !day) return false;
  if (h === day) return true;
  return h.startsWith(`${day} `) || h.startsWith(`${day}\n`);
};

/** @param {string} ymd @returns {number} 0=一 … 6=日 */
const dayIndexFromYmd = (ymd) => {
  const monday = mondayOfYmd(ymd);
  for (let i = 0; i < 7; i += 1) {
    if (addDaysYmd(monday, i) === ymd) return i;
  }
  return 0;
};

/**
 * 管理表單日欄表頭：星期＋完整日期（換行），匯入可穩定解析。
 * @param {string} ymd
 */
const formatDayColumnHeader = (ymd) =>
  `${DAY_HEADERS[dayIndexFromYmd(ymd)] || "一"}\n${ymd}`;

/**
 * 自表頭解析 yyyy-mm-dd（支援「一\\n2026-11-23」「一 2026-11-23」「2026-11-23」）。
 * @param {string} header
 * @returns {string|null}
 */
const parseDateFromHeader = (header) => {
  const h = normalizeHeader(header).replace(/\r/g, "").replace(/\n/g, " ");
  if (!h) return null;
  const full = /(\d{4}-\d{2}-\d{2})/.exec(h);
  if (full) return full[1];
  return null;
};

/**
 * 範本週次：本週起往後兩個月（與排班管理週次下拉一致）。
 * @param {string} [todayYmd]
 */
const listTemplateWeekStarts = (todayYmd) => {
  const today =
    todayYmd && /^\d{4}-\d{2}-\d{2}$/.test(String(todayYmd).trim())
      ? String(todayYmd).trim()
      : taipeiParts().date;
  const minStart = mondayOfYmd(today);
  const maxStart = mondayOfYmd(addMonthsYmd(today, 2));
  if (!minStart || !maxStart) return [];
  const weeks = [];
  let cursor = minStart;
  while (cursor <= maxStart) {
    weeks.push(cursor);
    cursor = addDaysYmd(cursor, 7);
  }
  return weeks;
};

/** 範本每日欄日期（連續週一…日） */
const listTemplateDates = (todayYmd) => {
  const dates = [];
  for (const weekStart of listTemplateWeekStarts(todayYmd)) {
    for (let i = 0; i < 7; i += 1) {
      dates.push(addDaysYmd(weekStart, i));
    }
  }
  return dates;
};

const loadLocationRulesByName = async (locationId) => {
  const rows = await db.query(
    `SELECT id, name, window_start, window_end
     FROM active_roll_call_rules
     WHERE location_id = ?
     ORDER BY window_start, id`,
    [locationId],
  );
  const byName = new Map();
  for (const row of rows || []) {
    const name = String(row.name || "").trim();
    if (!name) continue;
    byName.set(name, Number(row.id));
  }
  return { rules: rows || [], byName };
};

const loadMembersByEmployeeNo = async (locationId) => {
  const rows = await db.query(
    `SELECT p.id, p.employee_no, p.full_name
     FROM person_location_access pla
     INNER JOIN active_persons p ON p.id = pla.person_id
     WHERE pla.location_id = ? AND p.status = 'active'
     ORDER BY p.employee_no NULLS LAST, p.id`,
    [locationId],
  );
  const byEmployeeNo = new Map();
  for (const row of rows || []) {
    const employeeNo =
      row.employee_no != null ? String(row.employee_no).trim() : "";
    if (!employeeNo) continue;
    byEmployeeNo.set(employeeNo, {
      id: Number(row.id),
      employeeNo,
      fullName: row.full_name != null ? String(row.full_name) : "",
    });
  }
  return { members: [...byEmployeeNo.values()], byEmployeeNo };
};

const applyHeaderStyle = (cell, { weekend = false } = {}) => {
  cell.font = { bold: true };
  cell.fill = weekend ? WEEKEND_FILL : HEADER_FILL;
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
};

/**
 * 範本範圍內、嚴格早於 weekStart 的最近「有 DB 排班」週一。
 * @param {string} weekStart
 * @param {Iterable<string>} weeksWithData
 */
const findPriorWeekWithData = (weekStart, weeksWithData) => {
  let best = "";
  for (const week of weeksWithData || []) {
    if (!week || week >= weekStart) continue;
    if (week > best) best = week;
  }
  return best || null;
};

/** 單一日期預填值 */
const resolveDayCellValue = ({
  personId,
  ymd,
  defaultRule,
  assignmentByKey,
  weeksWithData,
}) => {
  const existing = assignmentByKey.get(`${personId}|${ymd}`);
  if (existing) return existing;
  const weekStart = mondayOfYmd(ymd);
  if (weeksWithData.has(weekStart)) return "休";
  const priorWeekStart = findPriorWeekWithData(weekStart, weeksWithData);
  if (!priorWeekStart) return defaultRule;
  return (
    assignmentByKey.get(
      `${personId}|${addDaysYmd(priorWeekStart, dayIndexFromYmd(ymd))}`,
    ) || "休"
  );
};

const ensureWeekBucket = (weeks, weekKey, weekDates) => {
  if (!weeks.has(weekKey)) {
    weeks.set(weekKey, {
      startDate: weekDates[0],
      endDate: weekDates[6],
      assignments: [],
    });
  }
  return weeks.get(weekKey);
};

const pushAssignmentCell = ({
  bucket,
  byName,
  personId,
  assignmentDate,
  cell,
  rowNo,
  columnLabel,
  errors,
}) => {
  if (OFF_TOKENS.has(cell)) return;
  const ruleId = byName.get(cell);
  if (!ruleId) {
    errors.push({
      row: rowNo,
      message: `「${columnLabel}」欄規則名稱無法對應：${cell}`,
    });
    return;
  }
  bucket.assignments.push({
    personId,
    assignmentDate,
    ruleId,
  });
};

const buildImportTemplateBuffer = async (locationId) => {
  const id = Number(locationId);
  const { rules } = await loadLocationRulesByName(id);
  const { members } = await loadMembersByEmployeeNo(id);
  const dates = listTemplateDates();
  const rangeStart = dates[0] || "";
  const rangeEnd = dates.length ? dates[dates.length - 1] : "";

  const existingAssignments =
    rangeStart && rangeEnd
      ? await listAssignments(id, rangeStart, rangeEnd)
      : [];

  const workbook = new ExcelJS.Workbook();
  const guide = workbook.addWorksheet("說明");
  guide.columns = [
    { header: "項目", key: "item", width: 18 },
    { header: "內容", key: "content", width: 78 },
  ];
  guide.addRow({
    item: "用途",
    content: "依「門禁名單」人員，填寫每人每日班別（簽到時間窗）",
  });
  guide.addRow({
    item: "版面",
    content:
      "每人一列；表頭為「星期＋日期」（例如 一／2026-11-23）。無「週起始」欄。範本範圍＝本週起往後兩個月",
  });
  guide.addRow({
    item: "每日欄",
    content:
      "請用下拉選「班別」名稱或「休」；空白／休／排休＝當日休假（主畫面仍顯示、不計應到）。勿手打改班別名拼字。可向下／向右填滿一次改多格",
  });
  guide.addRow({
    item: "預填",
    content:
      "已有排班之日帶入既有值；該週尚無排班時，若範圍內有較早有資料週則沿用同星期，否則預填第一個班別。須匯入後主畫面才生效",
  });
  guide.addRow({
    item: "色碼",
    content: "「班別」與「排班」日欄依班別名稱著色；休＝灰色，方便辨識",
  });
  guide.addRow({
    item: "人員",
    content: "工號須已在此地點門禁名單；請先於主畫面「門禁管理」加入（工號／姓名勿改）",
  });
  guide.addRow({
    item: "班別",
    content:
      "班別＝簽到時間窗；請於「地點管理 → 時段規則」新增後再下載範本",
  });

  const shiftSheet = workbook.addWorksheet("班別");
  shiftSheet.columns = [
    { header: "班別名稱", key: "name", width: 20 },
    { header: "開始", key: "windowStart", width: 12 },
    { header: "結束", key: "windowEnd", width: 12 },
    { header: "填入提示", key: "hint", width: 44 },
  ];
  /** @type {Map<string, number>} */
  const ruleNameToIndex = new Map();
  let ruleColorIndex = 0;
  for (const rule of rules) {
    const name = String(rule.name || "").trim();
    shiftSheet.addRow({
      name,
      windowStart: formatTime(rule.window_start),
      windowEnd: formatTime(rule.window_end),
      hint: "請用「排班」日欄下拉選擇",
    });
    if (name) {
      ruleNameToIndex.set(name, ruleColorIndex);
      ruleColorIndex += 1;
    }
  }
  if (rules.length === 0) {
    shiftSheet.addRow({
      name: "早班",
      windowStart: "06:00",
      windowEnd: "08:00",
      hint: "範例：請先在地點管理新增真實班別後再下載",
    });
    shiftSheet.addRow({
      name: "晚班",
      windowStart: "20:00",
      windowEnd: "22:00",
      hint: "範例",
    });
    ruleNameToIndex.set("早班", 0);
    ruleNameToIndex.set("晚班", 1);
  }
  shiftSheet.addRow({
    name: "休",
    windowStart: "",
    windowEnd: "",
    hint: "當日休假（顯示、不計應到；空白／排休同義）",
  });
  const shiftListEndRow = shiftSheet.rowCount;
  const shiftListFormula = `班別!$A$2:$A$${shiftListEndRow}`;
  for (let rowNo = 2; rowNo <= shiftListEndRow; rowNo += 1) {
    const nameCell = shiftSheet.getRow(rowNo).getCell(1);
    applyShiftCellStyle(nameCell, cellValueToString(nameCell.value), ruleNameToIndex);
  }

  const dayHeaders = dates.map((ymd) => formatDayColumnHeader(ymd));
  const sheet = workbook.addWorksheet("排班");
  sheet.columns = [
    { header: "工號", key: "employeeNo", width: 12 },
    { header: "姓名", key: "fullName", width: 14 },
    ...dayHeaders.map((header) => ({ header, key: header, width: 11 })),
  ];

  const sampleRule = rules[0]?.name ? String(rules[0].name).trim() : "早班";
  const sampleRule2 =
    rules[1]?.name != null ? String(rules[1].name).trim() : "晚班";
  const defaultRule = sampleRule;

  const assignmentByKey = new Map(
    existingAssignments.map((row) => [
      `${row.personId}|${row.assignmentDate}`,
      row.ruleName || defaultRule,
    ]),
  );
  const weeksWithData = new Set(
    existingAssignments.map((row) => mondayOfYmd(row.assignmentDate)),
  );

  if (members.length === 0) {
    const sample = {
      employeeNo: "A0001",
      fullName: "範例（請改為門禁名單人員）",
    };
    dayHeaders.forEach((header, index) => {
      if (index === 0) sample[header] = sampleRule;
      else if (index === 1) sample[header] = sampleRule2;
      else if (index === 3) sample[header] = "休";
      else if (index < 7) sample[header] = sampleRule;
      else sample[header] = "";
    });
    sheet.addRow(sample);
  } else {
    for (const member of members) {
      const row = {
        employeeNo: member.employeeNo,
        fullName: member.fullName,
      };
      dates.forEach((ymd, index) => {
        row[dayHeaders[index]] = resolveDayCellValue({
          personId: member.id,
          ymd,
          defaultRule,
          assignmentByKey,
          weeksWithData,
        });
      });
      sheet.addRow(row);
    }
  }

  const headerRow = sheet.getRow(1);
  headerRow.height = 32;
  applyHeaderStyle(headerRow.getCell(1));
  applyHeaderStyle(headerRow.getCell(2));
  dates.forEach((ymd, index) => {
    applyHeaderStyle(headerRow.getCell(3 + index), {
      weekend: dayIndexFromYmd(ymd) >= 5,
    });
  });

  const dataStart = 2;
  const dataEnd = Math.max(sheet.rowCount, 2);
  const dayValidation = {
    type: "list",
    allowBlank: true,
    formulae: [shiftListFormula],
    showErrorMessage: true,
    errorTitle: "無效班別",
    error: "請從下拉選單選擇班別或休",
    showInputMessage: true,
    promptTitle: "班別",
    prompt: "選班別或休；空白＝休假",
  };

  for (let rowNo = dataStart; rowNo <= dataEnd; rowNo += 1) {
    const row = sheet.getRow(rowNo);
    row.getCell(1).fill = META_FILL;
    row.getCell(2).fill = META_FILL;
    for (let col = 3; col <= 2 + dayHeaders.length; col += 1) {
      const cell = row.getCell(col);
      cell.dataValidation = dayValidation;
      cell.alignment = { vertical: "middle", horizontal: "center" };
      applyShiftCellStyle(cell, cellValueToString(cell.value), ruleNameToIndex);
    }
  }

  sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const rowsFromExcelBuffer = async (excelBuffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(excelBuffer);
  const sheet =
    workbook.getWorksheet("排班") ||
    workbook.worksheets.find((item) => {
      const name = String(item?.name || "");
      return name.includes("排班") && !name.includes("班別");
    }) ||
    workbook.worksheets.find((item) => {
      const header = cellValueToString(item?.getRow?.(1)?.getCell?.(1)?.value);
      return header === "工號" || header === "ID";
    }) ||
    workbook.worksheets[0];
  if (!sheet) {
    throwApiError(C.VALIDATION_REQUIRED, "Excel 無工作表");
  }
  let headers = [];
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (rowNumber === 1) {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        headers[colNumber - 1] = normalizeHeader(cellValueToString(cell.value));
      });
      while (headers.length > 0 && !headers[headers.length - 1]) {
        headers.pop();
      }
      return;
    }
    const obj = {};
    let hasAny = false;
    headers.forEach((header, index) => {
      if (!header) return;
      const value = cellValueToString(row.getCell(index + 1).value);
      obj[header] = value;
      if (value !== "") hasAny = true;
    });
    if (hasAny) rows.push(obj);
  });
  return { headers, rows };
};

const pick = (obj, keys) => {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== "") {
      return String(obj[key]).trim();
    }
  }
  const entries = Object.entries(obj || {});
  for (const key of keys) {
    const hit = entries.find(
      ([header]) => normalizeHeader(header) === normalizeHeader(key),
    );
    if (hit && String(hit[1]).trim() !== "") return String(hit[1]).trim();
  }
  return "";
};

/** 依曜日取儲存格（相容「一」與「一 11-02」；舊檔每週一列） */
const pickDayCell = (obj, day) => {
  const entries = Object.entries(obj || {});
  for (const [header, value] of entries) {
    if (!isDayHeaderMatch(header, day)) continue;
    // 寬表「一\\n2026-11-23」也會 match「一」；舊檔路徑僅在無日期表頭時使用
    if (parseDateFromHeader(header)) continue;
    return value != null ? String(value).trim() : "";
  }
  return "";
};

const listDateColumns = (headers) => {
  /** @type {Array<{ header: string, ymd: string }>} */
  const cols = [];
  for (const header of headers || []) {
    const ymd = parseDateFromHeader(header);
    if (!ymd) continue;
    cols.push({ header, ymd });
  }
  return cols;
};

/**
 * 解析並寫入排班。
 * - 新版寬表：每人一列，表頭含日期
 * - 舊檔：每人每週一列＋週起始＋一…日
 */
const importAssignmentsFromExcel = async (locationId, excelBuffer) => {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) {
    throwApiError(C.VALIDATION_REQUIRED, "地點無效");
  }
  if (!excelBuffer || !Buffer.isBuffer(excelBuffer)) {
    throwApiError(C.VALIDATION_REQUIRED, "請上傳 Excel 檔（欄位名稱：excel）");
  }

  const { byName } = await loadLocationRulesByName(id);
  const { byEmployeeNo } = await loadMembersByEmployeeNo(id);
  const { headers, rows } = await rowsFromExcelBuffer(excelBuffer);
  if (rows.length === 0) {
    throwApiError(C.VALIDATION_REQUIRED, "Excel 無資料列");
  }

  const dateColumns = listDateColumns(headers);
  const hasWeekStartHeader = headers.some((header) => {
    const h = normalizeHeader(header);
    return h === "週起始" || h === "週一" || h === "weekStart" || h === "week_start";
  });

  /** @type {Map<string, { startDate: string, endDate: string, assignments: object[] }>} */
  const weeks = new Map();
  const errors = [];

  if (dateColumns.length > 0) {
    rows.forEach((row, index) => {
      const rowNo = index + 2;
      const employeeNo = pick(row, ["工號", "ID", "員工編號", "employeeNo"]);
      if (!employeeNo) {
        errors.push({ row: rowNo, message: "工號不能為空" });
        return;
      }
      const person = byEmployeeNo.get(employeeNo);
      if (!person) {
        errors.push({
          row: rowNo,
          message: `工號 ${employeeNo} 不在此地點門禁名單`,
        });
        return;
      }
      for (const { header, ymd } of dateColumns) {
        let weekDates;
        try {
          weekDates = weekDatesFromMonday(mondayOfYmd(ymd));
        } catch (error) {
          errors.push({
            row: rowNo,
            message: error?.message || `表頭日期無效：${header}`,
          });
          continue;
        }
        const bucket = ensureWeekBucket(weeks, weekDates[0], weekDates);
        const cell = row[header] != null ? String(row[header]).trim() : "";
        pushAssignmentCell({
          bucket,
          byName,
          personId: person.id,
          assignmentDate: ymd,
          cell,
          rowNo,
          columnLabel: header.replace(/\n/g, " "),
          errors,
        });
      }
    });
  } else if (hasWeekStartHeader) {
    // 舊版：週起始＋一…日
    rows.forEach((row, index) => {
      const rowNo = index + 2;
      const employeeNo = pick(row, ["工號", "ID", "員工編號", "employeeNo"]);
      const weekStartRaw = pick(row, ["週起始", "週一", "weekStart", "week_start"]);
      if (!employeeNo) {
        errors.push({ row: rowNo, message: "工號不能為空" });
        return;
      }
      if (!weekStartRaw) {
        errors.push({ row: rowNo, message: "週起始不能為空" });
        return;
      }
      let weekDates;
      try {
        weekDates = weekDatesFromMonday(weekStartRaw);
      } catch (error) {
        errors.push({
          row: rowNo,
          message: error?.message || "週起始無效（須為週一 yyyy-mm-dd）",
        });
        return;
      }
      const person = byEmployeeNo.get(employeeNo);
      if (!person) {
        errors.push({
          row: rowNo,
          message: `工號 ${employeeNo} 不在此地點門禁名單`,
        });
        return;
      }
      const bucket = ensureWeekBucket(weeks, weekDates[0], weekDates);
      DAY_HEADERS.forEach((dayHeader, dayIndex) => {
        const cell = pickDayCell(row, dayHeader);
        pushAssignmentCell({
          bucket,
          byName,
          personId: person.id,
          assignmentDate: weekDates[dayIndex],
          cell,
          rowNo,
          columnLabel: dayHeader,
          errors,
        });
      });
    });
  } else {
    throwApiError(
      C.VALIDATION_REQUIRED,
      "無法辨識排班表頭（須為「星期＋日期」日欄，或舊版「週起始＋一…日」）",
    );
  }

  if (errors.length) {
    throwApiError(C.VALIDATION_REQUIRED, "排班匯入驗證失敗", {
      details: { errors },
    });
  }

  if (weeks.size === 0) {
    throwApiError(C.VALIDATION_REQUIRED, "Excel 無可匯入的排班日期欄");
  }

  const imported = [];
  for (const week of weeks.values()) {
    const list = await replaceAssignments(id, {
      startDate: week.startDate,
      endDate: week.endDate,
      assignments: week.assignments,
    });
    imported.push({
      startDate: week.startDate,
      endDate: week.endDate,
      count: list.length,
    });
  }

  const sortedStarts = [...weeks.keys()].sort();
  const importRangeStart = sortedStarts[0];
  const importRangeEnd = addDaysYmd(sortedStarts[sortedStarts.length - 1], 6);
  const assignments = await listAssignments(id, importRangeStart, importRangeEnd);

  return {
    weeks: imported,
    assignments,
  };
};

module.exports = {
  buildImportTemplateBuffer,
  importAssignmentsFromExcel,
  DAY_HEADERS,
  OFF_TOKENS,
  cellValueToString,
  isDayHeaderMatch,
  pickDayCell,
  listTemplateWeekStarts,
  listTemplateDates,
  formatDayColumnHeader,
  parseDateFromHeader,
  dayIndexFromYmd,
  resolveDayCellValue,
  findPriorWeekWithData,
  colorForShiftName,
  SHIFT_PALETTE,
  OFF_COLOR,
};
