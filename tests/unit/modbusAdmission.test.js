const assert = require("node:assert/strict");
const { setImmediate: flush } = require("node:timers/promises");
const { test } = require("node:test");
const limiter = require("../../src/services/devices/modbusGlobalLimiter");
const batch = require("../../src/services/devices/modbusBatchService");
const client = require("../../src/services/devices/modbusClient");
const planner = require("../../src/services/devices/modbusPollPlanner");
const db = require("../../src/database/db");

const deferred = () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  return { wait, release };
};

test("priority reads can start while routine slots are held by slow reads", async () => {
  const slow = deferred();
  const jobs = Array.from({ length: 20 }, () => limiter.run(() => slow.wait));
  try {
    assert.equal(limiter.getStats().standard.activeCount, 10);
    assert.equal(limiter.getStats().standard.queueSize, 10);
    const readings = [];
    const priorityReads = limiter.runWithPriority(() => Promise.all([
      limiter.run(() => readings.push(1)),
      limiter.run(() => readings.push(2)),
    ]));
    await flush();
    assert.deepEqual(readings, [1, 2]);
    await priorityReads;
    const stats = limiter.getStats();
    assert.equal(stats.standard.queueSize, 10);
    assert.equal(stats.priority.startedCount, 2);
    assert.ok(stats.priority.waitP95Ms >= 0);
    assert.equal(stats.peakQueueSize, 10);
  } finally {
    slow.release();
    await Promise.all(jobs);
    await flush();
  }
  assert.equal(limiter.getStats().activeCount, 0);
  assert.equal(limiter.getStats().queueSize, 0);
});

test("queued work keeps its lane when another lane frees capacity", async () => {
  const standardBlock = deferred();
  const priorityBlock = deferred();
  const dispatch = deferred();
  const parentBlock = deferred();
  const standardJobs = Array.from({ length: 9 }, () => limiter.run(() => standardBlock.wait));
  const priorityJobs = limiter.runWithPriority(() => [
    limiter.run(() => dispatch.wait),
    limiter.run(() => priorityBlock.wait),
    limiter.run(() => priorityBlock.wait),
  ]);
  let child;
  const parent = limiter.run(() => {
    child = limiter.run(() => {});
    return parentBlock.wait;
  });
  try {
    dispatch.release();
    await flush();
    assert.ok(child);
    assert.equal(limiter.getStats().standard.queueSize, 1);
    assert.equal(limiter.getStats().priority.queueSize, 0);
  } finally {
    standardBlock.release();
    priorityBlock.release();
    parentBlock.release();
    await Promise.all([...standardJobs, ...priorityJobs, parent]);
    await child;
  }
});

test("batch reads admit up to ten groups and preserve result order", async (t) => {
  const deviceRead = deferred();
  const reading = t.mock.method(client, "readHoldingRegisters", async (address) => {
    await deviceRead.wait;
    if (address === 3) throw new Error("simulated device timeout");
    return [address];
  });
  const done = batch.batchRead(Array.from({ length: 24 }, (_, address) => ({
    host: `batch-fixture-${address}`, port: 502, unitId: 1,
    registerType: "holding", address,
  })));
  try {
    await flush();
    assert.equal(reading.mock.callCount(), 10);
  } finally {
    deviceRead.release();
  }
  const results = await done;
  assert.equal(results[3].error, "simulated device timeout");
  assert.deepEqual(results[23].data, [23]);
  assert.equal(results.filter((result) => result.ok).length, 23);
});

for (const noCache of [false, true]) {
  test(`invalidated reads stay detached after a write (noCache=${noCache})`, async (t) => {
    const oldRead = deferred();
    const nextRead = deferred();
    let reads = 0;
    t.mock.method(client, "ensureConnection", async () => ({
      isOpen: true,
      readHoldingRegisters: () => ++reads === 1 ? oldRead.wait : nextRead.wait,
    }));
    const device = { host: `invalidation-${noCache}`, port: 502, unitId: 1 };
    const request = { ...device, registerType: "holding", address: 0 };
    const before = batch.batchRead([{ ...request, meta: { noCache } }]);
    await flush();
    batch.invalidateDeviceCache(device, "holding");
    const replacement = batch.batchRead([request]);
    try {
      await flush();
      assert.equal(reads, 2);
      oldRead.release({ data: [1] });
      assert.deepEqual((await before)[0].data, [1]);
      const coalesced = batch.batchRead([request]);
      nextRead.release({ data: [2] });
      assert.deepEqual((await replacement)[0].data, [2]);
      assert.deepEqual((await coalesced)[0].data, [2]);
      assert.deepEqual((await batch.batchRead([request]))[0].data, [2]);
      assert.equal(reads, 2);
    } finally {
      oldRead.release({ data: [1] });
      nextRead.release({ data: [2] });
      await Promise.all([before, replacement]);
    }
  });
}

test("DI/DO planner admits four controllers and carries priority through batch reads", async (t) => {
  const deviceRead = deferred();
  t.mock.method(db, "query", async () => Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    config: { host: `planner-fixture-${index}`, port: 502, unitId: 1 },
  })));
  const helper = require("../../src/services/alerts/systemAlertHelper");
  t.mock.method(helper, "notifyModbusHttpDeviceRecovered", async () => {});
  const read = t.mock.method(client, "readCoils", async (_address, length) =>
    limiter.run(async () => {
      await deviceRead.wait;
      return Array(length).fill(false);
    }),
  );
  const done = planner.pollControllers({ registerTypes: new Set(["coil"]), broadcastStatus: false });
  try {
    await flush();
    assert.equal(read.mock.callCount(), 4);
    assert.equal(limiter.getStats().priority.activeCount, 4);
  } finally {
    deviceRead.release();
  }
  assert.deepEqual(await done, { controllerCount: 10 });
  assert.equal(read.mock.callCount(), 10);
});
