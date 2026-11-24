const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  resolveStatusSnapshot,
  resolveZoneStatusSnapshot,
} = require("../../src/services/monitoring/resolveStatusSnapshot");
const {
  createSystemSnapshotMonitor,
} = require("../../src/services/monitoring/systemSnapshotMonitorFactory");
const websocket = require("../../src/services/websocket/websocketService");
const db = require("../../src/database/db");
const locationService = require("../../src/services/location/locationService");
const alertHelper = require("../../src/services/alerts/systemAlertHelper");
const bitStore = require("../../src/services/devices/modbusBitStore");
const modbusBatchService = require("../../src/services/devices/modbusBatchService");
const hvacStatus = require("../../src/services/snapshotStatus/hvacStatusService");
const lightingStatus = require("../../src/services/snapshotStatus/lightingStatusService");
const snapshotTasks = require("../../src/services/monitoring/snapshotTaskRegistry");
const { readAllStatusPoints } = require("../../src/services/snapshotStatus/modbusSnapshotHelpers");

const normal = { zoneId: "1", systemId: 11, uiStatus: "normal" };
const alarm = { ...normal, uiStatus: "alarm" };
const other = { zoneId: "2", systemId: 22, uiStatus: "normal" };
const zoneIdsOf = ({ items }) => items.map((item) => item.zoneId).sort();

test("snapshot monitor registration preserves cadence and lighting device IDs", async (t) => {
  assert.deepEqual(snapshotTasks.map(({ taskId, options }) => [taskId, options.startOffsetMs]), [
    ["lighting", 0], ["hvac", 2000], ["drainage", 4000], ["power", 6000],
    ["air_circulation", 8000], ["fire", 10000], ["emergency_rescue", 12000],
    ["smoke_alarm", 14000], ["security", 16000],
  ]);
  t.mock.method(lightingStatus, "getStatusSnapshot", async () => ({
    items: [{ ...normal, deviceId: 12 }],
  }));
  const emit = t.mock.method(websocket, "emitBatchDeviceStatus", () => {});

  await snapshotTasks[0].taskFunction();
  assert.deepEqual(emit.mock.calls[0].arguments[0], [
    { system: "lighting", sourceId: 11, deviceId: 12, status: "online" },
  ]);
});

test("HVAC and lighting share DI/DO reads while preserving snapshot values", async (t) => {
  const device = { host: "snapshot-fixture", port: 502, unitId: 1 };
  const modbus = { ...device, diAddress: 4, doAddress: 8 };
  const statusPoints = {
    temperatureC: { registerType: "holding", address: 20, transform: "value / 10" },
    feedback: { registerType: "discrete", address: 4 },
  };
  const zone = {
    id: 2, name: "Zone",
    locations: [{
      id: 3, name: "Location",
      systems: [{ id: 5, systemType: "hvac", config: { modbus, statusPoints } }],
    }],
  };
  t.mock.method(locationService, "getZones", async () => ({ zones: [zone] }));
  t.mock.method(locationService, "getZoneById", async () => ({ zone }));
  t.mock.method(db, "query", async (sql) => {
    if (sql.includes("active_location_systems")) {
      return [{
        zone_id: 2, zone_name: "Zone", location_id: 3, location_name: "Location",
        system_id: 6, device_id: null, modbus_config: modbus,
      }];
    }
    assert.match(sql, /FROM alerts/);
    return [];
  });
  t.mock.method(alertHelper, "syncLocationSnapshotReadResult", async () => {});
  t.after(() => bitStore._resetForTests());
  bitStore.setBit(device, "discrete", 4, false);
  bitStore.setBit(device, "coil", 8, false, { readAt: 0 });
  const batchRead = t.mock.method(modbusBatchService, "batchRead", async (points) =>
    points.map(({ address, registerType }) => {
      assert.notEqual(registerType, "discrete", "fresh DI should come from BitStore");
      return { ok: true, data: [address === 20 ? 237 : true] };
    }));

  const hvacSnapshot = await hvacStatus.getStatusSnapshot();
  assert.deepEqual(hvacSnapshot.items[0].raw, {
    temperatureC: 23.7, feedback: false, isOn: false,
  });
  assert.deepEqual(await hvacStatus.getZoneStatusSnapshot(2), {
    zoneId: "2", items: hvacSnapshot.items,
  });
  assert.deepEqual((await lightingStatus.getStatusSnapshot()).items[0].raw, {
    do: true, di: false, isOn: true,
  });
  assert.deepEqual(
    batchRead.mock.calls.map(({ arguments: [points] }) => points.map(({ address }) => address)),
    [[20], [20], [8]],
  );

  bitStore.setModuleHealth(device, {
    moduleId: 1, addressStart: 8, addressEnd: 15, status: "offline",
  });
  const [lighting] = (await lightingStatus.getStatusSnapshot()).items;
  assert.deepEqual(lighting.raw, { di: false, isOn: false });
  assert.equal(lighting.error, "IO 模組離線");
  assert.equal(batchRead.mock.callCount(), 3);
  assert.deepEqual(await readAllStatusPoints(statusPoints, null, modbus), {
    temperatureC: true, feedback: false,
  });
});

test("HVAC merges the active alert state after syncing the current read", async (t) => {
  const zone = {
    id: 1,
    locations: [{
      id: 2,
      systems: [{
        id: 3,
        systemType: "hvac",
        config: { modbus: { host: "alert-fixture", port: 502, unitId: 1, diAddress: 4 } },
      }],
    }],
  };
  let readable = false;
  let activeAlert = false;
  t.mock.method(locationService, "getZones", async () => ({ zones: [zone] }));
  t.mock.method(modbusBatchService, "batchRead", async () =>
    [readable ? { ok: true, data: [false] } : { ok: false }]);
  t.mock.method(alertHelper, "syncLocationSnapshotReadResult", async (_key, _id, ok) => {
    activeAlert = !ok;
  });
  t.mock.method(db, "query", async () => activeAlert ? [{ source_id: 3 }] : []);

  assert.equal((await hvacStatus.getStatusSnapshot()).items[0].uiStatus, "alarm");
  readable = true;
  assert.equal((await hvacStatus.getStatusSnapshot()).items[0].uiStatus, "normal");
});

test("cold zone reads cannot satisfy whole-system or unrelated zone requests", async () => {
  const key = "cold";
  const service = {
    getZoneStatusSnapshot: async () => ({ items: [normal] }),
    getStatusSnapshot: async ({ zoneIds }) => ({
      items: zoneIds?.length ? [other] : [normal, other],
    }),
  };
  const local = await resolveZoneStatusSnapshot(key, service, 1);
  assert.equal(local.fromCache, false);
  const alias = await resolveZoneStatusSnapshot(key, service, "001");
  assert.deepEqual(alias.items, [normal]);
  assert.equal(alias.fromCache, true);
  assert.equal((await resolveStatusSnapshot(key, service, { zoneIds: [1] })).fromCache, true);

  const unrelated = await resolveStatusSnapshot(key, service, { zoneIds: [2] });
  assert.equal(unrelated.fromCache, false);
  assert.deepEqual(zoneIdsOf(unrelated), ["2"]);

  const full = await resolveStatusSnapshot(key, service);
  assert.equal(full.fromCache, false);
  assert.deepEqual(zoneIdsOf(full), ["1", "2"]);
  assert.equal((await resolveStatusSnapshot(key, service)).fromCache, true);
});

test("forced filtered refresh updates only the requested zones", async () => {
  const key = "filtered";
  const service = {
    getStatusSnapshot: async ({ zoneIds }) => ({
      items: zoneIds?.length ? [alarm] : [normal, other],
    }),
  };
  const full = await resolveStatusSnapshot(key, service);
  const refreshed = await resolveStatusSnapshot(key, service, {
    zoneIds: [1],
    noCache: true,
  });
  assert.deepEqual(refreshed.items, [alarm]);
  assert.equal(refreshed.fromCache, false);
  const overview = await resolveStatusSnapshot(key, service);
  assert.deepEqual(zoneIdsOf(overview), ["1", "2"]);
  assert.ok(overview.items.includes(alarm));
  assert.equal(overview.fetchedAt, full.fetchedAt);
  assert.deepEqual((await resolveStatusSnapshot(key, service, { zoneIds: [2] })).items, [other]);
  assert.deepEqual(zoneIdsOf(await resolveStatusSnapshot(key, service, { zoneIds: [1, 2] })), ["1", "2"]);
});

test("out-of-order full and scoped reads preserve newer values", async () => {
  const key = "race";
  let completeFull;
  const slowFull = resolveStatusSnapshot(key, {
    getStatusSnapshot: () => new Promise((resolve) => { completeFull = resolve; }),
  });
  await resolveZoneStatusSnapshot(key, {
    getZoneStatusSnapshot: async () => ({ items: [alarm] }),
  }, 1);
  completeFull({ items: [normal, other] });
  assert.ok((await slowFull).items.includes(alarm));

  let completeZone;
  const slowZone = resolveZoneStatusSnapshot(key, {
    getZoneStatusSnapshot: () => new Promise((resolve) => { completeZone = resolve; }),
  }, 1, { force: true });
  await resolveStatusSnapshot(key, {
    getStatusSnapshot: async () => ({ items: [normal, other] }),
  }, { force: true });
  completeZone({ items: [alarm] });
  assert.deepEqual((await slowZone).items, [normal]);
});

test("REST refreshes preserve the monitor's WebSocket change baseline", async (t) => {
  const key = "push";
  const emit = t.mock.method(websocket, "emitMonitoringSnapshotUpdated", () => {});
  t.mock.method(websocket, "emitBatchDeviceStatus", () => {});
  let items = [normal, other];
  const monitor = createSystemSnapshotMonitor({
    systemKey: key,
    loggerName: "testSnapshot",
    getSnapshot: async () => ({ items }),
  });
  await monitor.check();
  assert.equal(emit.mock.callCount(), 0);

  items = [alarm, other];
  await resolveStatusSnapshot(key, {
    getStatusSnapshot: async () => ({ items }),
  }, { noCache: true });
  await monitor.check();
  await monitor.check();
  assert.equal(emit.mock.callCount(), 1);
  assert.deepEqual(emit.mock.calls[0].arguments[0].items, [alarm]);
});
