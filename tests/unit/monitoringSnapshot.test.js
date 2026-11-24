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

const normal = { zoneId: "1", systemId: 11, uiStatus: "normal" };
const alarm = { ...normal, uiStatus: "alarm" };
const other = { zoneId: "2", systemId: 22, uiStatus: "normal" };
const zoneIdsOf = ({ items }) => items.map((item) => item.zoneId).sort();

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
