/**
 * 雙管線排隊／地點 single-flight（mock，不需實機）
 *
 *   node --test tests/personnel/personSyncQueuePolicy.test.js
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setImmediate: flush } = require("node:timers/promises");

const store = require("../../src/services/personnel/personSyncJobStore");
const jobs = require("../../src/services/personnel/personSyncJobService");
const elevatorJobs = require("../../src/services/elevator/elevatorFloorSyncJobService");
const conflictWait = require("../../src/services/personnel/personSyncJobConflictWait");
const vehiclePlateSync = require("../../src/services/vehicleAccess/vehiclePlateSyncService");

test("progressTouchesLocation matches grant／revoke／current／touch", () => {
  assert.equal(
    conflictWait.progressTouchesLocation(
      { grantLocationIds: [3, 5], revokeLocationIds: [] },
      5,
    ),
    true,
  );
  assert.equal(
    conflictWait.progressTouchesLocation(
      { revokeLocationIds: [9], grantLocationIds: [] },
      9,
    ),
    true,
  );
  assert.equal(
    conflictWait.progressTouchesLocation({ currentLocationId: 12 }, 12),
    true,
  );
  assert.equal(
    conflictWait.progressTouchesLocation({ touchLocationIds: [7] }, 7),
    true,
  );
  assert.equal(
    conflictWait.progressTouchesLocation({ grantLocationIds: [1] }, 99),
    false,
  );
});

test("startSyncLocationJob reuses in-flight job for same location", async (t) => {
  t.mock.method(store, "findRunningJobByTypeAndLocation", async (type, locId) => {
    assert.equal(type, "sync_location");
    assert.equal(locId, 12);
    return "syncloc_existing";
  });
  const create = t.mock.method(store, "createJob", async () => {
    throw new Error("should not create");
  });
  const out = await jobs.startSyncLocationJob(12);
  assert.deepEqual(out, { jobId: "syncloc_existing", reused: true });
  assert.equal(create.mock.callCount(), 0);
});

test("elevator startLocationSyncJob reuses in-flight job for same location", async (t) => {
  t.mock.method(store, "findRunningJobByTypeAndLocation", async (type, locId) => {
    assert.equal(type, "elevator_sync_location");
    assert.equal(locId, 8);
    return "elevator_sync_existing";
  });
  const create = t.mock.method(store, "createJob", async () => {
    throw new Error("should not create");
  });
  const out = await elevatorJobs.startLocationSyncJob(8, 1);
  assert.deepEqual(out, { jobId: "elevator_sync_existing", reused: true });
  assert.equal(create.mock.callCount(), 0);
});

test("waitForConflictingPersonSyncJobs times out with 409 when person_sync touches location", async (t) => {
  const db = require("../../src/database/db");
  t.mock.method(db, "query", async () => [
    {
      job_id: "personsync_busy",
      progress: { personId: 1, grantLocationIds: [44], revokeLocationIds: [] },
    },
  ]);

  await assert.rejects(
    () => conflictWait.waitForConflictingPersonSyncJobs(44, { timeoutMs: 50 }),
    (err) => {
      assert.equal(err?.statusCode, 409);
      assert.match(String(err?.message || ""), /人員同步進行中/);
      return true;
    },
  );
});

test("waitForConflictingLocationJobs times out with 409", async (t) => {
  const db = require("../../src/database/db");
  t.mock.method(db, "query", async () => [
    { job_id: "syncloc_1", job_type: "sync_location", location_id: 3, status: "running" },
  ]);

  await assert.rejects(
    () => conflictWait.waitForConflictingLocationJobs([3], { timeoutMs: 50 }),
    (err) => {
      assert.equal(err?.statusCode, 409);
      assert.match(String(err?.message || ""), /地點同步進行中/);
      return true;
    },
  );
});

test("sync_location worker waits for conflicting person_sync before syncLocation", async (t) => {
  let waited = false;
  t.mock.method(store, "findRunningJobByTypeAndLocation", async () => null);
  t.mock.method(store, "createJob", async () => ({}));
  t.mock.method(store, "updateJob", async () => ({}));
  t.mock.method(store, "replaceWarnings", async () => {});
  t.mock.method(conflictWait, "waitForConflictingPersonSyncJobs", async (locId) => {
    assert.equal(locId, 55);
    waited = true;
  });

  const db = require("../../src/database/db");
  t.mock.method(db, "query", async () => []);

  const { jobId } = await jobs.startSyncLocationJob(55);
  assert.match(String(jobId), /^syncloc_/);
  // allow background worker to run wait + fail fast on no devices
  for (let i = 0; i < 20 && !waited; i += 1) await flush();
  assert.equal(waited, true);
});

test("syncPlatesForLocation waits for conflicting person_sync first", async (t) => {
  let waited = false;
  t.mock.method(conflictWait, "waitForConflictingPersonSyncJobs", async (locId) => {
    assert.equal(locId, 77);
    waited = true;
  });
  const db = require("../../src/database/db");
  t.mock.method(db, "query", async () => []);

  const out = await vehiclePlateSync.syncPlatesForLocation(77);
  assert.equal(waited, true);
  assert.equal(out.status, "skipped");
});
