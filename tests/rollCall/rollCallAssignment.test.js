/**
 * 時段簽到週曆排班：日期／應到篩選／休＝dayOff／Excel 表頭
 *
 *   node tests/rollCall/rollCallAssignment.test.js
 */
const assert = require("node:assert/strict");
const {
  parseYmd,
  weekDatesFromMonday,
  filterExpectedMembers,
  partitionRosterMembers,
  collectPartitionPersonIds,
  assertDateOrder,
} = require("../../src/services/rollCall/rollCallAssignmentService");
const {
  OFF_TOKENS,
  DAY_HEADERS,
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
} = require("../../src/services/rollCall/rollCallAssignmentImportService");
const {
  mondayOfYmd,
  addMonthsYmd,
  addDaysYmd,
} = require("../../src/services/rollCall/rollCallWindow");

const run = () => {
  assert.equal(parseYmd("2026-11-02"), "2026-11-02");
  assert.throws(() => parseYmd("2026-13-01"), /日期/);
  assert.throws(() => assertDateOrder("2026-11-09", "2026-11-02"), /開始日期/);

  const week = weekDatesFromMonday("2026-11-02");
  assert.deepEqual(week, [
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
    "2026-11-07",
    "2026-11-08",
  ]);
  assert.throws(() => weekDatesFromMonday("2026-11-03"), /週一/);

  const members = [
    { id: 1, employee_no: "A1" },
    { id: 2, employee_no: "A2" },
    { id: 3, employee_no: "A3" },
  ];
  assert.deepEqual(filterExpectedMembers(members, false, new Set([1])), members);
  assert.deepEqual(
    filterExpectedMembers(members, true, new Set([2, 3])).map((p) => p.id),
    [2, 3],
  );
  assert.deepEqual(
    filterExpectedMembers(members, true, new Set()).map((p) => p.id),
    [],
  );

  // legacy：全員 working
  assert.deepEqual(
    partitionRosterMembers(members, false, new Set(), new Set()),
    { working: members, dayOff: [] },
  );

  // 排班日：1→本場早班；2→他場晚班（不在本場、也非休）；3→完全無指派＝休
  const part = partitionRosterMembers(
    members,
    true,
    new Set([1]),
    new Set([1, 2]),
  );
  assert.deepEqual(
    part.working.map((p) => p.id),
    [1],
  );
  assert.deepEqual(
    part.dayOff.map((p) => p.id),
    [3],
  );

  // 全日休假
  assert.deepEqual(
    partitionRosterMembers(members, true, new Set(), new Set()).dayOff.map(
      (p) => p.id,
    ),
    [1, 2, 3],
  );

  // 場次裁舊：僅保留 working ∪ dayOff
  assert.deepEqual(
    [...collectPartitionPersonIds([{ id: 1 }, { id: 2 }], [{ id: 3 }])].sort(
      (a, b) => a - b,
    ),
    [1, 2, 3],
  );
  assert.deepEqual([...collectPartitionPersonIds([], [])], []);
  assert.deepEqual(
    [...collectPartitionPersonIds([{ id: "x" }, { id: 0 }], [{ id: 9 }])],
    [9],
  );

  assert.equal(DAY_HEADERS.length, 7);
  assert.equal(OFF_TOKENS.has(""), true);
  assert.equal(OFF_TOKENS.has("休"), true);
  assert.equal(OFF_TOKENS.has("早班"), false);

  assert.equal(isDayHeaderMatch("一", "一"), true);
  assert.equal(isDayHeaderMatch("一 11-02", "一"), true);
  assert.equal(isDayHeaderMatch("一\n11-02", "一"), true);
  assert.equal(isDayHeaderMatch("二 11-03", "一"), false);
  assert.equal(isDayHeaderMatch("一二", "一"), false);

  assert.equal(pickDayCell({ 一: "早班", 二: "晚班" }, "一"), "早班");
  assert.equal(pickDayCell({ "一 11-02": "休", "二 11-03": "晚班" }, "一"), "休");
  assert.equal(pickDayCell({ "一 11-02": "", 工號: "A1" }, "一"), "");
  assert.equal(pickDayCell({ 二: "晚班" }, "一"), "");

  assert.equal(mondayOfYmd("2026-11-04"), "2026-11-02");
  assert.equal(addMonthsYmd("2026-11-03", 2), "2027-01-03");
  const weeks = listTemplateWeekStarts("2026-11-03");
  assert.equal(weeks[0], "2026-11-02");
  assert.equal(
    weeks[weeks.length - 1],
    mondayOfYmd(addMonthsYmd("2026-11-03", 2)),
  );
  assert.ok(weeks.length >= 8 && weeks.length <= 10);

  assert.equal(findPriorWeekWithData("2026-11-16", ["2026-11-02", "2026-11-09"]), "2026-11-09");
  assert.equal(findPriorWeekWithData("2026-11-02", ["2026-11-09"]), null);
  assert.equal(findPriorWeekWithData("2026-11-09", []), null);

  assert.equal(dayIndexFromYmd("2026-11-23"), 0);
  assert.equal(dayIndexFromYmd("2026-11-29"), 6);
  assert.equal(formatDayColumnHeader("2026-11-23"), "一\n2026-11-23");
  assert.equal(formatDayColumnHeader("2026-11-29"), "日\n2026-11-29");
  assert.equal(parseDateFromHeader("一\n2026-11-23"), "2026-11-23");
  assert.equal(parseDateFromHeader("一 2026-11-23"), "2026-11-23");
  assert.equal(parseDateFromHeader("2026-11-23"), "2026-11-23");
  assert.equal(parseDateFromHeader("一"), null);
  assert.equal(parseDateFromHeader("週起始"), null);

  const dates = listTemplateDates("2026-11-23");
  assert.equal(dates[0], "2026-11-23");
  assert.equal(dates[6], "2026-11-29");
  assert.equal(dates[7], "2026-11-30");
  assert.equal(dates.length, listTemplateWeekStarts("2026-11-23").length * 7);

  const assignmentByKey = new Map([
    ["1|2026-11-02", "日班"],
    ["1|2026-11-03", "晚班"],
  ]);
  const weeksWithData = new Set(["2026-11-02"]);
  // 有資料日帶入；同週缺日＝休；空週沿用上週同星期；無歷史＝第一班別
  assert.equal(
    resolveDayCellValue({
      personId: 1,
      ymd: "2026-11-02",
      defaultRule: "日班",
      assignmentByKey,
      weeksWithData,
    }),
    "日班",
  );
  assert.equal(
    resolveDayCellValue({
      personId: 1,
      ymd: "2026-11-04",
      defaultRule: "日班",
      assignmentByKey,
      weeksWithData,
    }),
    "休",
  );
  assert.equal(
    resolveDayCellValue({
      personId: 1,
      ymd: "2026-11-09",
      defaultRule: "日班",
      assignmentByKey,
      weeksWithData,
    }),
    "日班",
  );
  assert.equal(
    resolveDayCellValue({
      personId: 1,
      ymd: addDaysYmd("2026-11-09", 1),
      defaultRule: "日班",
      assignmentByKey,
      weeksWithData,
    }),
    "晚班",
  );
  assert.equal(
    resolveDayCellValue({
      personId: 9,
      ymd: "2026-11-09",
      defaultRule: "日班",
      assignmentByKey: new Map(),
      weeksWithData: new Set(),
    }),
    "日班",
  );

  const ruleNameToIndex = new Map([
    ["日班", 0],
    ["晚班", 1],
  ]);
  assert.equal(colorForShiftName("休", ruleNameToIndex), OFF_COLOR);
  assert.equal(colorForShiftName("", ruleNameToIndex), OFF_COLOR);
  assert.deepEqual(colorForShiftName("日班", ruleNameToIndex), SHIFT_PALETTE[0]);
  assert.deepEqual(colorForShiftName("晚班", ruleNameToIndex), SHIFT_PALETTE[1]);

  // 舊檔 pickDayCell 略過含完整日期的寬表頭
  assert.equal(
    pickDayCell({ "一\n2026-11-23": "晚班", 一: "早班" }, "一"),
    "早班",
  );

  console.log("rollCallAssignment.test.js OK");
};

run();
