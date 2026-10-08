/**
 * 門禁列表「陌生」顯示（驗證失敗且無身分；不含酒精語意）
 *
 *   node tests/accessControl/accessStrangerDisplay.test.js
 */
const assert = require("node:assert/strict");
const {
  resolveAccessStrangerDisplay,
  FAIL_SUBS,
} = require("../../src/services/peopleCounting/accessControlLogLabels");
const {
  listTypeToAllowResult,
} = require("../../src/services/vehicleAccess/isapiVehiclePersistence");

assert.ok(FAIL_SUBS.has(76));

const faceFailStranger = resolveAccessStrangerDisplay({
  sub: 76,
  eventLabel: "失敗",
  personName: "",
  employeeId: null,
});
assert.equal(faceFailStranger.isStranger, true);
assert.equal(faceFailStranger.personName, "陌生");
assert.equal(faceFailStranger.eventLabel, "陌生");

const faceFailNamed = resolveAccessStrangerDisplay({
  sub: 76,
  eventLabel: "失敗",
  personName: "Ada",
  employeeId: null,
});
assert.equal(faceFailNamed.isStranger, false);
assert.equal(faceFailNamed.personName, "Ada");
assert.equal(faceFailNamed.eventLabel, "失敗");

const alcohol = resolveAccessStrangerDisplay({
  sub: 2078,
  eventLabel: "飲酒",
  personName: "",
  employeeId: null,
});
assert.equal(alcohol.isStranger, false);
assert.equal(alcohol.personName, "—");
assert.equal(alcohol.eventLabel, "飲酒");

const entryOk = resolveAccessStrangerDisplay({
  sub: 75,
  eventLabel: "進入",
  personName: "",
  employeeId: "E1",
});
assert.equal(entryOk.isStranger, false);
assert.equal(entryOk.personName, "—");
assert.equal(entryOk.eventLabel, "進入");

assert.equal(listTypeToAllowResult("allowList"), 1);
assert.equal(listTypeToAllowResult("white"), 1);
assert.equal(listTypeToAllowResult("blockList"), 0);
assert.equal(listTypeToAllowResult("unknown"), null);
assert.equal(listTypeToAllowResult("otherList"), null);
assert.equal(listTypeToAllowResult(""), null);

console.log("accessStrangerDisplay.test.js: OK");
