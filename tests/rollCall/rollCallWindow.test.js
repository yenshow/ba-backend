/**
 * 時段簽到跨日窗／開場解析（規則不依星期過濾）
 *
 *   node tests/rollCall/rollCallWindow.test.js
 */
const assert = require("node:assert/strict");
const {
  addDaysYmd,
  isOvernightWindow,
  resolveActiveWindow,
} = require("../../src/services/rollCall/rollCallWindow");

const taipeiDate = (ymd, hm) => new Date(`${ymd}T${hm}:00+08:00`);

const run = () => {
  assert.equal(isOvernightWindow(20 * 60, 5 * 60), true);
  assert.equal(isOvernightWindow(8 * 60, 20 * 60), false);
  assert.equal(addDaysYmd("2026-10-23", 1), "2026-10-24");
  assert.equal(addDaysYmd("2026-10-23", -1), "2026-10-22");

  const night = {
    enabled: true,
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

  const satNight = resolveActiveWindow(night, taipeiDate("2026-10-24", "21:00"));
  assert.equal(satNight?.sessionDate, "2026-10-24");
  assert.equal(satNight?.endIso, "2026-10-25T05:00:00+08:00");

  const day = {
    enabled: true,
    windowStart: "08:00",
    windowEnd: "20:00",
  };
  assert.equal(
    resolveActiveWindow(day, taipeiDate("2026-10-23", "07:59")),
    null,
  );
  const duringDay = resolveActiveWindow(day, taipeiDate("2026-10-23", "18:00"));
  assert.equal(duringDay?.sessionDate, "2026-10-23");
  assert.equal(duringDay?.endIso, "2026-10-23T20:00:00+08:00");
  assert.equal(
    resolveActiveWindow(day, taipeiDate("2026-10-24", "18:00"))?.sessionDate,
    "2026-10-24",
  );
};

run();
console.log("rollCallWindow.test.js ok");
