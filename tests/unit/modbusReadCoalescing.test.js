const assert = require("node:assert/strict");
const { test } = require("node:test");
const modbus = require("../../src/services/devices/modbusClient");
const C = require("../../src/utils/apiErrorCodes");

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
