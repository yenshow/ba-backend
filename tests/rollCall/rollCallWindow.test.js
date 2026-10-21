/**
 * 時段簽到跨日窗／每週重疊
 *
 *   node tests/rollCall/rollCallWindow.test.js
 */
const assert = require("node:assert/strict");
const {
  addDaysYmd,
  collectWeekSpans,
  isOvernightWindow,
  resolveActiveWindow,
  windowsOverlapOnWeek,
} = require("../../src/services/rollCall/rollCallWindow");

const taipeiDate = (ymd, hm) => new Date(`${ymd}T${hm}:00+08:00`);

const run = () => {
  assert.equal(isOvernightWindow(20 * 60, 5 * 60), true);
  assert.equal(isOvernightWindow(8 * 60, 20 * 60), false);
  assert.equal(addDaysYmd("2026-10-23", 1), "2026-10-24");
  assert.equal(addDaysYmd("2026-10-23", -1), "2026-10-22");

  // 早班 [08:00, 20:00) 與晚班 [20:00, 05:00) 不重疊
  assert.equal(
    windowsOverlapOnWeek(
      8 * 60,
      20 * 60,
      [1, 2, 3, 4, 5],
      20 * 60,
      5 * 60,
      [1, 2, 3, 4, 5],
    ),
    false,
  );

  // 週五 20:00–05:00 與週六 00:00–08:00 重疊
  assert.equal(
    windowsOverlapOnWeek(20 * 60, 5 * 60, [5], 0, 8 * 60, [6]),
    true,
  );

  // 週日跨日尾段與週一清晨重疊
  assert.equal(
    windowsOverlapOnWeek(20 * 60, 5 * 60, [7], 0, 8 * 60, [1]),
    true,
  );

  const night = {
    enabled: true,
    weekdays: [5],
    windowStart: "20:00",
    windowEnd: "05:00",
  };
  const friNight = resolveActiveWindow(night, taipeiDate("2026-10-23", "21:00"));
  assert.equal(friNight?.sessionDate, "2026-10-23");
  assert.equal(friNight?.startIso, "2026-10-23T20:00:00+08:00");
  assert.equal(friNight?.endIso, "2026-10-24T05:00:00+08:00");

  const satTail = resolveActiveWindow(night, taipeiDate("2026-10-24", "02:00"));
  assert.equal(satTail?.sessionDate, "2026-10-23");
  assert.equal(satTail?.endIso, "2026-10-24T05:00:00+08:00");

  const satAfter = resolveActiveWindow(night, taipeiDate("2026-10-24", "06:00"));
  assert.equal(satAfter, null);

  const day = {
    enabled: true,
    weekdays: [5],
    windowStart: "08:00",
    windowEnd: "20:00",
  };
  const beforeStart = resolveActiveWindow(day, taipeiDate("2026-10-23", "07:59"));
  assert.equal(beforeStart, null);
  const duringDay = resolveActiveWindow(day, taipeiDate("2026-10-23", "18:00"));
  assert.equal(duringDay?.sessionDate, "2026-10-23");
  assert.equal(duringDay?.endIso, "2026-10-23T20:00:00+08:00");

  const spans = collectWeekSpans(20 * 60, 5 * 60, [7]);
  assert.equal(spans.length, 2);
};

run();
console.log("rollCallWindow.test.js ok");
