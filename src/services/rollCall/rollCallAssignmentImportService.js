/**
 * 時段簽到排班 Excel：工號｜姓名｜週起始｜一…日
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

const loadLocationRulesByName = async (locationId) => {
  const rows = await db.query(
    `SELECT id, name, window_start, window_end
     FROM roll_call_rules
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
     INNER JOIN persons p ON p.id = pla.person_id
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

const applyHeaderStyle = (cell, { weekend = false } = {}) => {
  cell.font = { bold: true };
  cell.fill = weekend ? WEEKEND_FILL : HEADER_FILL;
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
};

const buildDayCellsForWeek = ({
  personId,
  weekStart,
  defaultRule,
  assignmentByKey,
  weekEmpty,
}) => {
  const cells = {};
  DAY_HEADERS.forEach((day, index) => {
    const date = addDaysYmd(weekStart, index);
    const existing = assignmentByKey.get(`${personId}|${date}`);
    if (existing) {
      cells[day] = existing;
      return;
    }
    cells[day] = weekEmpty ? defaultRule : "休";
  });
  return cells;
};

const buildImportTemplateBuffer = async (locationId) => {
  const id = Number(locationId);
  const { rules } = await loadLocationRulesByName(id);
  const { members } = await loadMembersByEmployeeNo(id);
  const weekStarts = listTemplateWeekStarts();
  const rangeStart = weekStarts[0] || "";
  const rangeEnd = weekStarts.length
    ? addDaysYmd(weekStarts[weekStarts.length - 1], 6)
    : "";

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
    item: "週起始",
    content:
      "必須為該週週一（yyyy-mm-dd）；範本已預填本週起往後兩個月（每人每週一列）",
  });
  guide.addRow({
    item: "一～日",
    content:
      "請用下拉選「班別」名稱或「休」；空白／休／排休＝當日休假（主畫面仍顯示、不計應到）。實際日期看「週起始」。勿手打改班別名拼字",
  });
  guide.addRow({
    item: "預填",
    content:
      "空週預填第一個班別；已有排班之週帶入既有值，缺日＝休（與畫面相同）。須儲存／匯入後主畫面才生效",
  });
  guide.addRow({
    item: "人員",
    content: "工號須已在此地點門禁名單；請先於主畫面「門禁管理」加入（工號／姓名勿改）",
  });
  guide.addRow({
    item: "班別",
    content:
      "班別＝簽到時間窗；請於「地點管理 → 時段規則」新增後再下載範本。哪一天上哪班／休請在「排班」一～日欄選擇",
  });

  const shiftSheet = workbook.addWorksheet("班別");
  shiftSheet.columns = [
    { header: "班別名稱", key: "name", width: 20 },
    { header: "開始", key: "windowStart", width: 12 },
    { header: "結束", key: "windowEnd", width: 12 },
    { header: "填入提示", key: "hint", width: 44 },
  ];
  for (const rule of rules) {
    shiftSheet.addRow({
      name: String(rule.name || "").trim(),
      windowStart: formatTime(rule.window_start),
      windowEnd: formatTime(rule.window_end),
      hint: "請用「排班」一～日欄下拉選擇",
    });
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
  }
  shiftSheet.addRow({
    name: "休",
    windowStart: "",
    windowEnd: "",
    hint: "當日休假（顯示、不計應到；空白／排休同義）",
  });
  const shiftListEndRow = shiftSheet.rowCount;
  const shiftListFormula = `班別!$A$2:$A$${shiftListEndRow}`;

  // 多週時表頭用純一…日（日期看「週起始」欄）
  const sheet = workbook.addWorksheet("排班");
  sheet.columns = [
    { header: "工號", key: "employeeNo", width: 14 },
    { header: "姓名", key: "fullName", width: 16 },
    { header: "週起始", key: "weekStart", width: 14 },
    ...DAY_HEADERS.map((day) => ({ header: day, key: day, width: 12 })),
  ];

  const sampleRule = rules[0]?.name ? String(rules[0].name).trim() : "早班";
  const sampleRule2 =
    rules[1]?.name != null ? String(rules[1].name).trim() : "晚班";
  const defaultRule = sampleRule;
  const firstWeek = weekStarts[0] || "2026-11-02";

  if (members.length === 0) {
    sheet.addRow({
      employeeNo: "A0001",
      fullName: "範例（請改為門禁名單人員）",
      weekStart: firstWeek,
      一: sampleRule,
      二: sampleRule2,
      三: sampleRule,
      四: "休",
      五: sampleRule2,
      六: "",
      日: "",
    });
  } else {
    const assignmentByKey = new Map(
      existingAssignments.map((row) => [
        `${row.personId}|${row.assignmentDate}`,
        row.ruleName || defaultRule,
      ]),
    );
    const weeksWithData = new Set(
      existingAssignments.map((row) => mondayOfYmd(row.assignmentDate)),
    );
    for (const weekStart of weekStarts) {
      const weekEmpty = !weeksWithData.has(weekStart);
      for (const member of members) {
        sheet.addRow({
          employeeNo: member.employeeNo,
          fullName: member.fullName,
          weekStart,
          ...buildDayCellsForWeek({
            personId: member.id,
            weekStart,
            defaultRule,
            assignmentByKey,
            weekEmpty,
          }),
        });
      }
    }
  }

  const headerRow = sheet.getRow(1);
  headerRow.height = 28;
  for (let col = 1; col <= 3; col += 1) {
    applyHeaderStyle(headerRow.getCell(col));
  }
  DAY_HEADERS.forEach((day, index) => {
    const col = 4 + index;
    const weekend = day === "六" || day === "日";
    applyHeaderStyle(headerRow.getCell(col), { weekend });
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
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const col = 4 + dayIndex;
      const cell = row.getCell(col);
      cell.dataValidation = dayValidation;
      if (dayIndex >= 5) {
        cell.fill = WEEKEND_FILL;
      }
    }
  }

  sheet.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];

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
  return rows;
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

/** 依曜日取儲存格（相容「一」與「一 11-02」） */
const pickDayCell = (obj, day) => {
  const entries = Object.entries(obj || {});
  for (const [header, value] of entries) {
    if (!isDayHeaderMatch(header, day)) continue;
    return value != null ? String(value).trim() : "";
  }
  return "";
};

/**
 * 解析並寫入排班。同一檔可含多週（不同週起始列）。
 * 每個出現的週區間各自整段取代。
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
  const rows = await rowsFromExcelBuffer(excelBuffer);
  if (rows.length === 0) {
    throwApiError(C.VALIDATION_REQUIRED, "Excel 無資料列");
  }

  /** @type {Map<string, { startDate: string, endDate: string, assignments: object[] }>} */
  const weeks = new Map();
  const errors = [];

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

    const weekKey = weekDates[0];
    if (!weeks.has(weekKey)) {
      weeks.set(weekKey, {
        startDate: weekDates[0],
        endDate: weekDates[6],
        assignments: [],
      });
    }
    const bucket = weeks.get(weekKey);

    DAY_HEADERS.forEach((dayHeader, dayIndex) => {
      const cell = pickDayCell(row, dayHeader);
      if (OFF_TOKENS.has(cell)) return;
      const ruleId = byName.get(cell);
      if (!ruleId) {
        errors.push({
          row: rowNo,
          message: `「${dayHeader}」欄規則名稱無法對應：${cell}`,
        });
        return;
      }
      bucket.assignments.push({
        personId: person.id,
        assignmentDate: weekDates[dayIndex],
        ruleId,
      });
    });
  });

  if (errors.length) {
    throwApiError(C.VALIDATION_REQUIRED, "排班匯入驗證失敗", {
      details: { errors },
    });
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
  const rangeStart = sortedStarts[0];
  const rangeEnd = addDaysYmd(sortedStarts[sortedStarts.length - 1], 6);
  const assignments = await listAssignments(id, rangeStart, rangeEnd);

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
};
