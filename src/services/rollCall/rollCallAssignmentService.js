/**
 * 時段簽到週曆排班：人員 × 日期 → 規則（單一地點多規則）。
 * 排班日由 `roll_call_roster_dates` 標記（儲存／匯入區間會寫入）；
 * 未標記＝legacy 全門禁名單。已標記但無 assignment＝全日排休（應到 0）。
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { formatPgDate, addDaysYmd } = require("./rollCallWindow");

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const assertLocationIsRollCall = async (locationId) => {
  const rows = await db.query(
    `SELECT 1 FROM location_systems
     WHERE location_id = ? AND system_type = 'roll_call'
     LIMIT 1`,
    [locationId],
  );
  if (!rows?.length) {
    throwApiError(C.NOT_FOUND, "找不到時段簽到地點");
  }
};

const parseYmd = (value, label = "日期") => {
  const text = String(value ?? "").trim();
  const match = YMD_RE.exec(text);
  if (!match) {
    throwApiError(C.VALIDATION_REQUIRED, `${label}格式須為 yyyy-mm-dd`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throwApiError(C.VALIDATION_REQUIRED, `${label}無效`);
  }
  return text;
};

const assertDateOrder = (startDate, endDate) => {
  if (startDate > endDate) {
    throwApiError(C.VALIDATION_REQUIRED, "開始日期不可晚於結束日期");
  }
};

/** 展開 [start, end] 含端點之日字串 */
const eachYmdInRange = (startDate, endDate) => {
  const out = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    out.push(cursor);
    cursor = addDaysYmd(cursor, 1);
  }
  return out;
};

/** 該地點該日是否已啟用排班（`roll_call_roster_dates` 有標記） */
const isRosterDateActive = async (locationId, dateStr) => {
  const rows = await db.query(
    `SELECT 1 FROM roll_call_roster_dates
     WHERE location_id = ? AND roster_date = ?::date
     LIMIT 1`,
    [locationId, dateStr],
  );
  return Boolean(rows?.length);
};

/** 當日指派到指定規則的 person_id 集合 */
const loadAssignedPersonIds = async (locationId, dateStr, ruleId) => {
  const rows = await db.query(
    `SELECT person_id FROM roll_call_assignments
     WHERE location_id = ? AND assignment_date = ?::date AND rule_id = ?`,
    [locationId, dateStr, ruleId],
  );
  return new Set(
    (rows || [])
      .map((row) => Number(row.person_id))
      .filter((id) => Number.isFinite(id) && id > 0),
  );
};

/** 純函式：有排班日則門禁 ∩ 指派；否則全名單 */
const filterExpectedMembers = (members, rosterActive, assignedPersonIds) => {
  const list = Array.isArray(members) ? members : [];
  if (!rosterActive) return list;
  const assigned =
    assignedPersonIds instanceof Set
      ? assignedPersonIds
      : new Set(assignedPersonIds || []);
  return list.filter((person) => assigned.has(Number(person.id)));
};

/**
 * 門禁名單 ∩ 當日排班（若 `roll_call_roster_dates` 已標記該日）。
 * @returns {Promise<object[]>} persons rows
 */
const resolveExpectedMembers = async (locationId, ruleId, sessionDate, members) => {
  const active = await isRosterDateActive(locationId, sessionDate);
  if (!active) return filterExpectedMembers(members, false, null);
  const assigned = await loadAssignedPersonIds(locationId, sessionDate, ruleId);
  return filterExpectedMembers(members, true, assigned);
};

const mapAssignment = (row) => ({
  id: Number(row.id),
  locationId: Number(row.location_id),
  personId: Number(row.person_id),
  employeeNo:
    row.employee_no != null ? String(row.employee_no).trim() : "",
  fullName: row.full_name != null ? String(row.full_name) : "",
  assignmentDate: formatPgDate(row.assignment_date),
  ruleId: Number(row.rule_id),
  ruleName: row.rule_name != null ? String(row.rule_name) : "",
});

const listAssignments = async (locationId, startDate, endDate) => {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) {
    throwApiError(C.VALIDATION_REQUIRED, "地點無效");
  }
  const start = parseYmd(startDate, "開始日期");
  const end = parseYmd(endDate, "結束日期");
  assertDateOrder(start, end);

  await assertLocationIsRollCall(id);

  const rows = await db.query(
    `SELECT a.id, a.location_id, a.person_id, a.assignment_date, a.rule_id,
            p.employee_no, p.full_name, r.name AS rule_name
     FROM roll_call_assignments a
     INNER JOIN persons p ON p.id = a.person_id
     INNER JOIN roll_call_rules r ON r.id = a.rule_id
     WHERE a.location_id = ?
       AND a.assignment_date >= ?::date
       AND a.assignment_date <= ?::date
     ORDER BY a.assignment_date, p.employee_no NULLS LAST, a.person_id`,
    [id, start, end],
  );
  return (rows || []).map(mapAssignment);
};

/**
 * 以完整清單取代區間內排班。
 * body.assignments: Array<{ personId, assignmentDate, ruleId }>
 */
const replaceAssignments = async (locationId, body = {}) => {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) {
    throwApiError(C.VALIDATION_REQUIRED, "地點無效");
  }
  const start = parseYmd(body.startDate ?? body.start_date, "開始日期");
  const end = parseYmd(body.endDate ?? body.end_date, "結束日期");
  assertDateOrder(start, end);

  await assertLocationIsRollCall(id);

  const rawList = Array.isArray(body.assignments) ? body.assignments : [];
  const ruleRows = await db.query(
    `SELECT id FROM roll_call_rules WHERE location_id = ?`,
    [id],
  );
  const ruleIds = new Set(
    (ruleRows || [])
      .map((row) => Number(row.id))
      .filter((n) => Number.isFinite(n)),
  );

  const memberRows = await db.query(
    `SELECT pla.person_id
     FROM person_location_access pla
     INNER JOIN persons p ON p.id = pla.person_id
     WHERE pla.location_id = ? AND p.status = 'active'`,
    [id],
  );
  const memberIds = new Set(
    (memberRows || [])
      .map((row) => Number(row.person_id))
      .filter((n) => Number.isFinite(n)),
  );

  /** @type {Map<string, { personId: number, assignmentDate: string, ruleId: number }>} */
  const unique = new Map();
  for (const item of rawList) {
    const personId = Number(item.personId ?? item.person_id);
    const ruleId = Number(item.ruleId ?? item.rule_id);
    const assignmentDate = parseYmd(
      item.assignmentDate ?? item.assignment_date,
      "排班日期",
    );
    if (!Number.isFinite(personId) || personId <= 0) {
      throwApiError(C.VALIDATION_REQUIRED, "人員無效");
    }
    if (!Number.isFinite(ruleId) || ruleId <= 0 || !ruleIds.has(ruleId)) {
      throwApiError(C.VALIDATION_REQUIRED, "規則不屬於此地點");
    }
    if (assignmentDate < start || assignmentDate > end) {
      throwApiError(C.VALIDATION_REQUIRED, "排班日期須在指定區間內");
    }
    if (!memberIds.has(personId)) {
      throwApiError(
        C.VALIDATION_REQUIRED,
        `人員 ${personId} 不在此地點門禁名單`,
      );
    }
    unique.set(`${personId}:${assignmentDate}`, {
      personId,
      assignmentDate,
      ruleId,
    });
  }

  await db.transaction(async (tx) => {
    await tx(
      `DELETE FROM roll_call_assignments
       WHERE location_id = ?
         AND assignment_date >= ?::date
         AND assignment_date <= ?::date`,
      [id, start, end],
    );
    for (const row of unique.values()) {
      await tx(
        `INSERT INTO roll_call_assignments
          (location_id, person_id, assignment_date, rule_id)
         VALUES (?, ?, ?::date, ?)`,
        [id, row.personId, row.assignmentDate, row.ruleId],
      );
    }
    // 標記區間每日為排班日（即使全日排休、無 assignment 列）
    for (const ymd of eachYmdInRange(start, end)) {
      await tx(
        `INSERT INTO roll_call_roster_dates (location_id, roster_date)
         VALUES (?, ?::date)
         ON CONFLICT (location_id, roster_date) DO NOTHING`,
        [id, ymd],
      );
    }
  });

  return listAssignments(id, start, end);
};

/** 給定週一，回傳該週七天 ymd */
const weekDatesFromMonday = (mondayYmd) => {
  const monday = parseYmd(mondayYmd, "週起始");
  const parts = monday.split("-").map(Number);
  const utc = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const dow = new Date(utc).getUTCDay(); // 0=Sun … 1=Mon
  if (dow !== 1) {
    throwApiError(C.VALIDATION_REQUIRED, "週起始須為週一（yyyy-mm-dd）");
  }
  return Array.from({ length: 7 }, (_, index) => addDaysYmd(monday, index));
};

module.exports = {
  parseYmd,
  assertDateOrder,
  isRosterDateActive,
  loadAssignedPersonIds,
  filterExpectedMembers,
  resolveExpectedMembers,
  listAssignments,
  replaceAssignments,
  weekDatesFromMonday,
  mapAssignment,
};
