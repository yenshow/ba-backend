const assert = require("node:assert/strict");
const { setImmediate: flush } = require("node:timers/promises");
const { test } = require("node:test");
const limiter = require("../../src/services/devices/modbusGlobalLimiter");
const batch = require("../../src/services/devices/modbusBatchService");
const client = require("../../src/services/devices/modbusClient");
const planner = require("../../src/services/devices/modbusPollPlanner");
const db = require("../../src/database/db");
const { resolveModbusDeviceConfig } = require("../../src/services/devices/modbusDeviceConfig");
const bitStore = require("../../src/services/devices/modbusBitStore");
const { shouldSuppressCoilStateChange } = bitStore;
const alertLinkage = require("../../src/services/alerts/alertLinkageService");
const hvacSchedule = require("../../src/services/hvac/hvacScheduleService");
const lightingSchedule = require("../../src/services/lighting/lightingScheduleService");
const { resolveDiDoParts } = require("../../src/services/devices/modbusDiDoConfig");

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

test("batch reads admit up to ten devices and preserve result order", async (t) => {
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

test("writes take a limiter seat and serialize behind reads on the same endpoint", async (t) => {
  const device = { host: "write-admit-fixture", port: 502, unitId: 1 };
  const readGate = deferred();
  const order = [];
  t.mock.method(client, "ensureConnection", async () => ({
    isOpen: true,
    readHoldingRegisters: async () => {
      order.push("read-start");
      await readGate.wait;
      order.push("read-end");
      return { data: [1] };
    },
    writeCoil: async () => {
      order.push("write");
      return { address: 0, state: true };
    },
  }));
  const reading = client.readHoldingRegisters(0, 1, device);
  await flush();
  assert.equal(limiter.getStats().activeCount, 1);
  const writing = client.writeCoil(0, true, device);
  await flush();
  assert.ok(!order.includes("write"));
  readGate.release();
  assert.deepEqual(await reading, [1]);
  assert.equal(await writing, true);
  assert.deepEqual(order, ["read-start", "read-end", "write"]);
  await flush();
  assert.equal(limiter.getStats().activeCount, 0);
});

test("batch serializes different register types on the same device", async (t) => {
  const device = { host: "same-device-serial", port: 502, unitId: 1 };
  const first = deferred();
  const order = [];
  const coilRead = t.mock.method(client, "readCoils", async () => {
    order.push("coil-start");
    await first.wait;
    order.push("coil-end");
    return [true];
  });
  const discreteRead = t.mock.method(client, "readDiscreteInputs", async () => {
    order.push("discrete");
    return [false];
  });
  const done = batch.batchRead([
    { ...device, registerType: "coil", address: 0 },
    { ...device, registerType: "discrete", address: 0 },
  ]);
  await flush();
  assert.deepEqual(order, ["coil-start"]);
  assert.equal(coilRead.mock.callCount(), 1);
  assert.equal(discreteRead.mock.callCount(), 0);
  first.release();
  const results = await done;
  assert.deepEqual(order, ["coil-start", "coil-end", "discrete"]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.deepEqual(results[0].data, [true]);
  assert.deepEqual(results[1].data, [false]);
});

test("successful single and multiple coil writes invalidate the coil read cache", async (t) => {
  const device = { host: "coil-write-fixture", port: 502, unitId: 1 };
  let actual = false;
  const coilRead = t.mock.method(client, "readCoils", async () => [actual]);
  const holdingRead = t.mock.method(client, "readHoldingRegisters", async () => [42]);
  const writeCoil = t.mock.method(client, "writeCoil", async (_address, value) => {
    actual = value;
    return true;
  });
  const writeCoils = t.mock.method(client, "writeCoils", async (_address, values) => {
    actual = values[0];
    return true;
  });
  const marksAtInvalidation = [];
  const invalidate = client.invalidateReads.bind(client);
  t.mock.method(client, "invalidateReads", (config, registerType) => {
    marksAtInvalidation.push([7, 8, 9].map((address) =>
      shouldSuppressCoilStateChange(config, address)));
    invalidate(config, registerType);
  });
  const read = async () => (await batch.batchRead([
    { ...device, registerType: "coil", address: 7 },
    { ...device, registerType: "holding", address: 7 },
  ])).map(({ data }) => data[0]);

  assert.deepEqual(await read(), [false, 42]);
  assert.equal(await batch.writeCoilValues(7, true, device), true);
  assert.deepEqual(await read(), [true, 42]);
  assert.equal(await batch.writeCoilValues(7, [false, true], device), true);
  assert.deepEqual(await read(), [false, 42]);
  assert.deepEqual(writeCoil.mock.calls[0].arguments, [7, true, device]);
  assert.deepEqual(writeCoils.mock.calls[0].arguments, [7, [false, true], device]);

  writeCoil.mock.mockImplementation(async () => false);
  assert.equal(await batch.writeCoilValues(9, true, device), false);
  assert.equal(shouldSuppressCoilStateChange(device, 9), false);
  assert.deepEqual(await read(), [false, 42]);
  assert.equal(coilRead.mock.callCount(), 3);
  assert.equal(holdingRead.mock.callCount(), 1);
  assert.deepEqual(marksAtInvalidation, [[true, false, false], [true, true, false]]);
});

test("Modbus endpoint resolution shares pending lookups and sees subsequent changes", async (t) => {
  const first = deferred();
  const inline = { host: "legacy", port: 502 };
  const query = t.mock.method(db, "query", async () => first.wait);
  const a = resolveModbusDeviceConfig("123", inline);
  const b = resolveModbusDeviceConfig(123);
  assert.equal(query.mock.callCount(), 1);
  assert.match(query.mock.calls[0].arguments[0], /FROM active_devices WHERE id = \?.*archived_at IS NULL/);
  first.release([{ config: '{"host":" original ","port":"502","unitId":0}' }]);
  const original = { host: "original", port: 502, unitId: 0 };
  assert.deepEqual(await Promise.all([a, b]), [original, original]);

  query.mock.mockImplementation(async () => [{ config: { host: "edited", port: 1502 } }]);
  assert.deepEqual(await resolveModbusDeviceConfig(123), { host: "edited", port: 1502, unitId: 1 });
  query.mock.mockImplementation(async () => { throw new Error("database temporarily unavailable"); });
  await assert.rejects(resolveModbusDeviceConfig(123), /temporarily unavailable/);
  query.mock.mockImplementation(async () => [{ config: {} }]);
  assert.deepEqual(await resolveModbusDeviceConfig(123, inline), { ...inline, unitId: 1 });
  query.mock.mockImplementation(async () => []);
  assert.equal(await resolveModbusDeviceConfig(123, inline), null);
  assert.deepEqual(await resolveModbusDeviceConfig(null, inline), { ...inline, unitId: 1 });
});

test("alert linkage suppresses the DO edge before inserting its execution record", async (t) => {
  const endpoint = { host: "linkage-fixture", port: 502, unitId: 1 };
  const insertStates = [];
  t.mock.method(db, "query", async (sql) => {
    if (sql.includes("FROM active_alert_linkages")) {
      return [{ id: 1, do_device_id: 3, do_address: 4, do_output_value: "on" }];
    }
    if (sql.includes("SELECT config FROM active_devices")) return [{ config: endpoint }];
    if (sql.includes("INSERT INTO alert_linkage_executions")) {
      insertStates.push(shouldSuppressCoilStateChange(endpoint, 4));
      return [{ id: 2 }];
    }
    return [];
  });
  t.mock.method(client, "writeCoil", async () => true);
  const recordEvent = t.mock.method(
    require("../../src/services/operationalEvents/operationalEventService"), "recordEvent", async () => {},
  );
  assert.deepEqual(await alertLinkage.manualTriggerLinkage(1), { success: true });
  await flush();
  assert.deepEqual(insertStates, [true]);
  assert.equal(recordEvent.mock.calls[0].arguments[0].ref_id, 2);
});

test("DI/DO resolution skips invalid addresses and accepts explicitly configured zero", () => {
  assert.deepEqual(resolveDiDoParts({ address: null, doAddress: "", diAddress: false }), {
    di: null, do: null,
  });
  assert.deepEqual(resolveDiDoParts({
    points: [{ type: "do", address: null }, { type: "do", address: "0" }],
    diAddresses: [null, -1, 1.5, 7],
  }), {
    di: { registerType: "discrete", address: 7 },
    do: { registerType: "coil", address: 0 },
  });
});

test("lighting and HVAC schedule independently, coalesce overlapping ticks and stop", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: new Date("2026-11-24T02:20:00Z") });
  const hvacWrite = deferred();
  const rulesRead = { hvac: 0, lighting: 0 };
  const device = { host: "schedule-fixture", port: 502, unitId: 1 };
  t.mock.method(db, "query", async (sql, params) => {
    if (sql.includes("FROM active_hvac_schedule_rules")) rulesRead.hvac += 1;
    else if (sql.includes("FROM active_lighting_schedule_rules")) rulesRead.lighting += 1;
    else if (sql.includes("_schedule_rule_locations")) return [{ rule_id: 1, location_id: 2 }];
    else if (sql.includes("AND ls.location_id")) {
      return [{ device_id: 3, modbus_config: { doAddress: params[0] === "hvac" ? 0 : 1 } }];
    } else if (sql.includes("SELECT config FROM active_devices")) return [{ config: device }];
    else return [];
    return [{ id: 1, days_of_week: [2], on_time: "10:20", off_time: "17:00" }];
  });
  t.mock.method(require("../../src/services/operationalEvents/operationalEventService"), "recordEvent", async () => {});
  const write = t.mock.method(batch, "writeCoilValues", async (address) => {
    if (address === 0) await hvacWrite.wait;
    return true;
  });

  hvacSchedule.start();
  hvacSchedule.start();
  lightingSchedule.start();
  try {
    await flush();
    assert.deepEqual(write.mock.calls.map((call) => call.arguments), [
      [0, true, device], [1, true, device],
    ]);
    assert.deepEqual(rulesRead, { hvac: 1, lighting: 1 });
    t.mock.timers.tick(15_000);
    await flush();
    assert.deepEqual(rulesRead, { hvac: 1, lighting: 2 });
    assert.equal(write.mock.callCount(), 2);

    let stopped = false;
    const stopping = hvacSchedule.stop().then(() => { stopped = true; });
    await lightingSchedule.stop();
    t.mock.timers.tick(15_000);
    await flush();
    assert.equal(stopped, false);
    assert.deepEqual(rulesRead, { hvac: 1, lighting: 2 });
    hvacWrite.release();
    await stopping;
    assert.equal(stopped, true);
  } finally {
    hvacWrite.release();
    await Promise.all([hvacSchedule.stop(), lightingSchedule.stop()]);
  }
});

for (const noCache of [false, true]) {
  test(`invalidated reads stay detached after a write (noCache=${noCache})`, async (t) => {
    const oldRead = deferred();
    const nextRead = deferred();
    let reads = 0;
    t.mock.method(client, "ensureConnection", async () => ({
      isOpen: true,
      readHoldingRegisters: () => (++reads === 1 ? oldRead.wait : nextRead.wait),
    }));
    const device = { host: `invalidation-${noCache}`, port: 502, unitId: 1 };
    const request = { ...device, registerType: "holding", address: 0 };
    const before = batch.batchRead([{ ...request, meta: { noCache } }]);
    await flush();
    batch.invalidateDeviceCache(device, "holding");
    const replacement = batch.batchRead([request]);
    try {
      await flush();
      // 同端點 FIFO：失效後補讀須等進行中 FC 結束才會開始第二筆
      assert.equal(reads, 1);
      oldRead.release({ data: [1] });
      assert.deepEqual((await before)[0].data, [1]);
      await flush();
      assert.equal(reads, 2);
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
  const { controllerCount, deviceConfigs } = await done;
  assert.equal(controllerCount, 10);
  assert.deepEqual(deviceConfigs.get(1), { host: "planner-fixture-0", port: 502, unitId: 1 });
  assert.equal(read.mock.callCount(), 10);
});

test("DI/DO monitor reads the endpoint used by the current planner cycle", async (t) => {
  const monitor = require("../../src/services/monitoring/diDoMonitor");
  const alertRules = require("../../src/services/alerts/alertRuleService");
  const operationalEvents = require("../../src/services/operationalEvents/operationalEventService");
  const original = { host: "old-monitor-fixture", port: 502, unitId: 1 };
  const updated = { ...original, host: "new-monitor-fixture" };
  let endpoint = original;
  t.after(() => {
    monitor._resetEdgeStateForTests();
    bitStore._resetForTests();
  });
  const query = t.mock.method(db, "query", async (sql) => {
    assert.match(sql, /FROM active_location_systems/);
    return [{
      system_id: 99,
      location_id: 98,
      system_type: "hvac",
      system_config: { device_ids: [22], modbus_config: { diAddress: 4 } },
    }];
  });
  t.mock.method(alertRules, "getEnabledDiDoRules", async () => []);
  t.mock.method(planner, "pollControllers", async () => ({
    controllerCount: 1,
    deviceConfigs: new Map([[22, endpoint]]),
  }));
  const event = t.mock.method(operationalEvents, "recordEvent", async () => {});
  bitStore.setBit(original, "discrete", 4, false);
  bitStore.setBit(updated, "discrete", 4, true);
  await monitor.checkDiDoAlerts();
  assert.equal(event.mock.callCount(), 0);

  endpoint = updated;
  await monitor.checkDiDoAlerts();
  assert.equal(query.mock.callCount(), 2);
  assert.equal(event.mock.callCount(), 1);
  assert.equal(event.mock.calls[0].arguments[0].new_value, true);
});
