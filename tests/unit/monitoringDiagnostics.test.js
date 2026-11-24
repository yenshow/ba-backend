const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const express = require("express");
const responseHandler = require("../../src/middleware/responseHandler");
const userService = require("../../src/services/platform/userService");
const snapshotCache = require("../../src/services/monitoring/monitoringSnapshotCache");
const monitoringRoutes = require("../../src/routes/monitoringRoutes");

test("monitoring diagnostics require an administrator and expose only full snapshot ages", async (t) => {
  t.mock.method(userService, "verifyToken", (token) => ({
    id: 1, role: token === "fixture-admin" ? "admin" : "user", permissions: [],
  }));
  t.mock.method(userService, "verifyTokenVersion", async () => ({ ok: true }));
  snapshotCache.setSnapshot("full-fixture", { items: [{ zoneId: "1" }] }, {
    version: snapshotCache.beginSnapshotRead(),
  });
  snapshotCache.setSnapshot("partial-fixture", { items: [{ zoneId: "2" }] }, {
    version: snapshotCache.beginSnapshotRead(), zoneIds: [2],
  });

  const app = express();
  app.use(responseHandler);
  app.use("/api/monitoring", monitoringRoutes);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/monitoring/diagnostics`;
  const anonymous = await fetch(url);
  assert.equal(anonymous.status, 401);
  await anonymous.json();
  const user = await fetch(url, { headers: { Authorization: "Bearer fixture-user" } });
  assert.equal(user.status, 403);
  await user.json();
  const admin = await fetch(url, { headers: { Authorization: "Bearer fixture-admin" } });
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get("cache-control"), "no-store");
  const body = await admin.json();
  assert.equal(body.success, true);
  assert.equal(body.data.modbus.reservedPrioritySlots, 2);
  assert.deepEqual(body.data.scheduler.tasks, []);
  assert.deepEqual(body.data.snapshots.map((entry) => entry.systemKey), ["full-fixture"]);
  assert.ok(body.data.snapshots[0].ageMs >= 0);
  assert.equal(body.data.snapshots[0].items, undefined);
});
