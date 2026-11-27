/**
 * 人臉簽到不得覆寫休假（leave）
 *
 *   node --test tests/rollCall/rollCallFaceLeave.test.js
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  canFacePromoteAttendanceStatus,
} = require("../../src/services/rollCall/rollCallService");

test("leave 與 present 不可被人臉改為 present；pending／absent 可以", () => {
  assert.equal(canFacePromoteAttendanceStatus("leave"), false);
  assert.equal(canFacePromoteAttendanceStatus("present"), false);
  assert.equal(canFacePromoteAttendanceStatus("pending"), true);
  assert.equal(canFacePromoteAttendanceStatus("absent"), true);
});
