const assert = require("node:assert/strict");
const { setImmediate: flush } = require("node:timers/promises");
const { test } = require("node:test");
const modbus = require("../../src/services/devices/modbusClient");
const limiter = require("../../src/services/devices/modbusGlobalLimiter");
const C = require("../../src/utils/apiErrorCodes");

const deferred = () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  return { wait, release };
};

test("a connection that closes before the read can be retried", async (t) => {
  const device = { host: "unit-test", port: 502, unitId: 1 };
  let connections = 0;
  const connect = t.mock.method(modbus, "ensureConnection", async () => ({
    isOpen: ++connections > 1,
    readHoldingRegisters: async () => ({ data: [42] }),
  }));

  await assert.rejects(
    modbus.readHoldingRegisters(0, 1, device),
    { code: C.MODBUS_CONNECTION_CLOSED },
  );
  const reads = await Promise.all([
    modbus.readHoldingRegisters(0, 1, device),
    modbus.readHoldingRegisters(0, 1, device),
  ]);
  assert.deepEqual(reads, [[42], [42]]);
  assert.equal(connect.mock.callCount(), 2);
});

test("coalesced reads share one connection and one limiter seat", async (t) => {
  const device = { host: "coalesce-seat", port: 502, unitId: 1 };
  const gate = deferred();
  let connects = 0;
  t.mock.method(modbus, "ensureConnection", async () => {
    connects += 1;
    return {
      isOpen: true,
      readHoldingRegisters: async () => {
        await gate.wait;
        return { data: [7] };
      },
    };
  });
  const a = modbus.readHoldingRegisters(0, 1, device);
  const b = modbus.readHoldingRegisters(0, 1, device);
  await flush();
  assert.equal(connects, 1);
  assert.equal(limiter.getStats().activeCount, 1);
  gate.release();
  assert.deepEqual(await Promise.all([a, b]), [[7], [7]]);
  await flush();
  assert.equal(limiter.getStats().activeCount, 0);
});
