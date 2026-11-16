/**
 * Modbus DI/DO ioModules／BitStore
 *
 *   npm run test:modbus-io-modules
 */
const assert = require("node:assert/strict");
const {
  resolveIoModules,
  validateAndNormalizeIoModules,
  assertAddressInIoModules,
  findModuleForAddress,
  IMPLICIT_MASTER,
} = require("../../src/services/devices/modbusIoModules");
const bitStore = require("../../src/services/devices/modbusBitStore");
const { splitModuleRanges } = require("../../src/services/devices/modbusPollPlanner");

const fail = (msg) => {
  throw new Error(msg);
};

const run = () => {
  // 隱式 master
  {
    const mods = resolveIoModules({});
    assert.equal(mods.length, 1);
    assert.equal(mods[0].moduleId, IMPLICIT_MASTER.moduleId);
    assert.equal(mods[0].addressEnd, 15);
  }

  // 正規化主＋副
  {
    const cfg = {
      ioModules: [
        { role: "master", moduleId: 0, addressStart: 0, addressEnd: 15 },
        {
          role: "slave",
          moduleId: 1,
          serial: "S1",
          addressStart: 16,
          addressEnd: 31,
        },
      ],
    };
    validateAndNormalizeIoModules(cfg, fail);
    assert.equal(cfg.ioModules.length, 2);
    assert.equal(cfg.ioModules[1].serial, "S1");
  }

  // 區間重疊
  {
    let threw = false;
    try {
      validateAndNormalizeIoModules(
        {
          ioModules: [
            { role: "master", moduleId: 0, addressStart: 0, addressEnd: 15 },
            { role: "slave", moduleId: 1, addressStart: 15, addressEnd: 30 },
          ],
        },
        fail,
      );
    } catch (e) {
      threw = /重疊/.test(String(e?.message || e));
    }
    assert.equal(threw, true, "預期區間重疊錯誤");
  }

  // 位址落點
  {
    const cfg = {
      ioModules: [
        { role: "master", moduleId: 0, addressStart: 0, addressEnd: 15 },
      ],
    };
    assert.equal(assertAddressInIoModules(cfg, 16).ok, false);
    assert.equal(assertAddressInIoModules(cfg, 5).ok, true);
    assert.equal(assertAddressInIoModules({}, 99).ok, true);
  }

  // findModuleForAddress
  {
    const mods = resolveIoModules({
      ioModules: [
        { role: "master", moduleId: 0, addressStart: 0, addressEnd: 15 },
        { role: "slave", moduleId: 1, addressStart: 16, addressEnd: 31 },
      ],
    });
    assert.equal(findModuleForAddress(mods, 17)?.moduleId, 1);
    assert.equal(findModuleForAddress(mods, 100), null);
  }

  // BitStore
  {
    bitStore._resetForTests();
    const cfg = { host: "10.0.0.1", port: 502, unitId: 1 };
    bitStore.setBit(cfg, "coil", 0, true, { ok: true, readAt: Date.now() });
    assert.equal(bitStore.getBit(cfg, "coil", 0)?.value, true);

    bitStore.setModuleHealth(cfg, {
      moduleId: 1,
      role: "slave",
      addressStart: 16,
      addressEnd: 31,
      status: "offline",
      checkedAt: Date.now(),
    });
    assert.equal(bitStore.isModuleOnlineForAddress(cfg, 20), false);
    assert.equal(bitStore.isModuleOnlineForAddress(cfg, 0), true);
    bitStore._resetForTests();
  }

  // range split
  {
    const chunks = splitModuleRanges({ addressStart: 0, addressEnd: 200 });
    assert.deepEqual(chunks[0], { start: 0, length: 125 });
    assert.deepEqual(chunks[1], { start: 125, length: 76 });
  }

  console.log("modbusIoModules.test.js: OK");
};

run();
