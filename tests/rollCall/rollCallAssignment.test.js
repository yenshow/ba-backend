/**
 * 時段簽到週曆排班：日期／應到篩選／Excel 休班語意／表頭正規化
 *
 *   node tests/rollCall/rollCallAssignment.test.js
 */
const assert = require("node:assert/strict");
const {
  parseYmd,
  weekDatesFromMonday,
  filterExpectedMembers,
  assertDateOrder,
} = require("../../src/services/rollCall/rollCallAssignmentService");
const {
  OFF_TOKENS,
  DAY_HEADERS,
  isDayHeaderMatch,
  pickDayCell,
  listTemplateWeekStarts,
} = require("../../src/services/rollCall/rollCallAssignmentImportService");
const {
  mondayOfYmd,
  addMonthsYmd,
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
  assert.equal(weeks[weeks.length - 1], mondayOfYmd(addMonthsYmd("2026-11-03", 2)));
  assert.ok(weeks.length >= 8 && weeks.length <= 10);

  console.log("rollCallAssignment.test.js OK");
};

run();
