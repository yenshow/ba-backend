const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setImmediate: flush } = require("node:timers/promises");
const db = require("../../src/database/db");
const store = require("../../src/services/personnel/personSyncJobStore");
const jobs = require("../../src/services/personnel/personSyncJobService");
const accessControl = require("../../src/services/accessControl/accessControlService");

for (const [jobType, start] of [
  ["sync_location", () => jobs.startSyncLocationJob(12)],
  ["sync_all_locations", () => jobs.startSyncAllLocationsJob()],
]) {
  test(`${jobType} persists queued before updating or returning the job ID`, async (t) => {
    const insert = Promise.withResolvers();
    const completed = Promise.withResolvers();
    const create = t.mock.method(store, "createJob", () => insert.promise);
    const update = t.mock.method(store, "updateJob", async (_jobId, patch) => {
      if (patch.status === "completed") completed.resolve(patch);
    });
    t.mock.method(store, "replaceWarnings", async () => {});
    t.mock.method(db, "query", async () => []);

    let acknowledged = false;
    const starting = start().then((job) => {
      acknowledged = true;
      return job;
    });
    try {
      await flush();
      const queued = create.mock.calls[0].arguments[0];
      assert.equal(queued.jobType, jobType);
      assert.equal(queued.status, "queued");
      assert.equal(update.mock.callCount(), 0);
      assert.equal(acknowledged, false);

      insert.resolve();
      assert.deepEqual(await starting, { jobId: queued.jobId });
      const ended = await completed.promise;
      const statuses = update.mock.calls
        .map(({ arguments: [, patch] }) => patch.status)
        .filter(Boolean);
      assert.deepEqual(statuses, ["running", "completed"]);
      if (jobType === "sync_location") {
        assert.match(ended.error.message, /未設定門禁設備/);
      } else {
        assert.deepEqual(ended.result, { synced: 0, results: [] });
      }
    } finally {
      insert.resolve();
      await starting;
      await completed.promise;
    }
  });

  test(`${jobType} propagates an insert failure without starting the worker`, async (t) => {
    t.mock.method(store, "createJob", async () => {
      throw new Error("storage unavailable");
    });
    const update = t.mock.method(store, "updateJob", async () => {});
    await assert.rejects(start, /storage unavailable/);
    assert.equal(update.mock.callCount(), 0);
  });
}

test("a delayed progress write finishes before the job is marked completed", async (t) => {
  const progressWrite = Promise.withResolvers();
  const reachedWarnings = Promise.withResolvers();
  const finished = Promise.withResolvers();
  t.mock.method(db, "query", async (sql) =>
    sql.includes("FROM active_location_systems WHERE location_id")
      ? [{ system_config: { entry_device_ids: [1] } }]
      : []);
  t.mock.method(accessControl, "searchUserInfo", async () => ({ list: [] }));
  t.mock.method(store, "createJob", async () => {});
  t.mock.method(store, "replaceWarnings", async () => reachedWarnings.resolve());
  const update = t.mock.method(store, "updateJob", async (_id, patch) => {
    if (patch.status === "completed") finished.resolve(patch);
    if (!patch.status) await progressWrite.promise;
  });

  await jobs.startSyncLocationJob(12);
  try {
    await reachedWarnings.promise;
    const patches = update.mock.calls.map(({ arguments: [, patch] }) => patch);
    assert.ok(patches.some((patch) => !patch.status));
    assert.ok(patches.every((patch) => patch.status !== "completed"));
  } finally {
    progressWrite.resolve();
    const completed = await finished.promise;
    assert.equal(completed.progress.currentDeviceId, null);
    assert.equal(completed.error, null);
  }
});
