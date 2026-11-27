/**
 * 門禁縮減／清空後場次 soft-remove（含 present／absent／leave）
 *
 *   node --test tests/rollCall/rollCallRosterPrune.test.js
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");

const db = require("../../src/database/db");
const {
  softRemoveAttendanceOutsideKeep,
} = require("../../src/services/rollCall/rollCallAssignmentService");

test("softRemove empty keep：裁全部活躍列且不限 pending", async (t) => {
  const calls = [];
  t.mock.method(db, "query", async (sql, params) => {
    calls.push({ sql, params });
    return [];
  });

  await softRemoveAttendanceOutsideKeep(42, []);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /roster_removed_at = CURRENT_TIMESTAMP/);
  assert.match(calls[0].sql, /roster_removed_at IS NULL/);
  assert.doesNotMatch(calls[0].sql, /status\s*=\s*'pending'/i);
  assert.doesNotMatch(calls[0].sql, /active_persons/i);
  assert.doesNotMatch(calls[0].sql, /NOT IN/i);
  assert.deepEqual(calls[0].params, [42]);
});

test("softRemove with keep：排除保留 id 且不限 pending", async (t) => {
  const calls = [];
  t.mock.method(db, "query", async (sql, params) => {
    calls.push({ sql, params });
    return [];
  });

  await softRemoveAttendanceOutsideKeep(7, [1, "2", 0, "x", 2]);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /roster_removed_at = CURRENT_TIMESTAMP/);
  assert.match(calls[0].sql, /NOT IN/i);
  assert.doesNotMatch(calls[0].sql, /status\s*=\s*'pending'/i);
  assert.doesNotMatch(calls[0].sql, /active_persons/i);
  assert.deepEqual(calls[0].params, [7, 1, 2]);
});

test("softRemove invalid sessionId：不打 DB", async (t) => {
  const query = t.mock.method(db, "query", async () => []);
  await softRemoveAttendanceOutsideKeep(0, [1]);
  await softRemoveAttendanceOutsideKeep(NaN, []);
  assert.equal(query.mock.callCount(), 0);
});
