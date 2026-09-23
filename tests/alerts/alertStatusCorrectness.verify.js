/**
 * 警報狀態 CAS：並行 resolve 只寫入一筆 recovered 事件。
 *
 *   node tests/alerts/alertStatusCorrectness.verify.js
 *   或 npm run test:alert-status-correctness
 *
 * disposable source_id；結束後刪除。
 */
const assert = require("node:assert/strict");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({
  path: process.env.ENV_FILE || path.resolve(__dirname, "../../.env"),
  quiet: true,
});

const db = require("../../src/database/db");
const alertService = require("../../src/services/alerts/alertService");

const TEST_SOURCE_ID = 999991;
const TEST_SOURCE = "device";
const TEST_TYPE = "offline";
const TEST_DIM = "offline:verify-cas";

const cleanup = async () => {
  await db.query(
    `DELETE FROM alerts
     WHERE source = ?
       AND source_id = ?
       AND dimension_key = ?`,
    [TEST_SOURCE, TEST_SOURCE_ID, TEST_DIM],
  );
};

const insertAlert = async (status) => {
  const rows = await db.query(
    `INSERT INTO alerts (
       source, source_id, alert_type, dimension_key, severity, message, status
     ) VALUES (
       ?::alert_source, ?, ?::alert_type, ?, 'warning'::alert_severity, ?, ?::alert_status
     )
     RETURNING id, status`,
    [
      TEST_SOURCE,
      TEST_SOURCE_ID,
      TEST_TYPE,
      TEST_DIM,
      "verify-cas disposable alert",
      status,
    ],
  );
  return rows[0];
};

const run = async () => {
  await cleanup();

  const active = await insertAlert("active");
  const results = await Promise.allSettled([
    alertService.updateAlertStatus(
      TEST_SOURCE_ID,
      TEST_SOURCE,
      TEST_TYPE,
      alertService.ALERT_STATUS.RESOLVED,
      null,
      { dimensionKey: TEST_DIM, reason: "recovered" },
    ),
    alertService.updateAlertStatus(
      TEST_SOURCE_ID,
      TEST_SOURCE,
      TEST_TYPE,
      alertService.ALERT_STATUS.RESOLVED,
      null,
      { dimensionKey: TEST_DIM, reason: "recovered" },
    ),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason?.message || ""), /未找到可更新的警報/);
  assert.equal(fulfilled[0].value, 1);

  const after = await db.query(`SELECT status FROM alerts WHERE id = ?`, [
    active.id,
  ]);
  assert.equal(after[0].status, "resolved");

  const ev = await db.query(
    `SELECT COUNT(*)::int AS n, array_agg(payload->>'reason') AS reasons
     FROM alert_events WHERE alert_id = ? AND event_type = 'resolved'`,
    [active.id],
  );
  assert.equal(ev[0].n, 1);
  assert.deepEqual(ev[0].reasons, ["recovered"]);

  await cleanup();
  console.log("alertStatusCorrectness.verify.js: OK");
};

run()
  .then(async () => {
    await db.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch (_) {}
    try {
      await db.close();
    } catch (_) {}
    process.exit(1);
  });
