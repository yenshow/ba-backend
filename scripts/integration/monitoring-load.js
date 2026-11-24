// Isolated benchmark: ephemeral loopback HTTP/Socket.IO, simulated devices and database.
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const { setTimeout: sleep } = require("node:timers/promises");
const { performance } = require("node:perf_hooks");

process.env.ENV_FILE = path.join(__dirname, "monitoring-load.fixture.env");
process.env.LOG_LEVEL ??= "error";

const express = require("express");
const { io: connectSocket } = require("../../../ba-frontend-central/node_modules/socket.io-client");
const db = require("../../src/database/db");
const userService = require("../../src/services/platform/userService");
const permissions = require("../../src/access/permissionService");
const alerts = require("../../src/services/alerts/systemAlertHelper");
const client = require("../../src/services/devices/modbusClient");
const planner = require("../../src/services/devices/modbusPollPlanner");
const batch = require("../../src/services/devices/modbusBatchService");
const monitoring = require("../../src/services/monitoring/backgroundMonitor");
const snapshotCache = require("../../src/services/monitoring/monitoringSnapshotCache");
const websocket = require("../../src/services/websocket/websocketService");
const responseHandler = require("../../src/middleware/responseHandler");
const monitoringRoutes = require("../../src/routes/monitoringRoutes");
const { recordEvent } = require("../../src/services/operationalEvents/operationalEventService");
const { createSystemSnapshotMonitor } = require("../../src/services/monitoring/systemSnapshotMonitorFactory");
const C = require("../../src/utils/apiErrorCodes");

const scenarios = {
  mixed: { batches: 4, groups: 24, direct: 40, snapshotOutageMs: 0 },
  burst: { batches: 8, groups: 32, direct: 120, snapshotOutageMs: 1500 },
};
const token = "local-monitoring-fixture";
const device = (host) => ({ host, port: 502, unitId: 1 });
let writes = 0;

function installFixtures() {
  userService.verifyToken = (value) => value === token ? { id: 1, role: "admin" } : null;
  userService.verifyTokenVersion = async () => ({ ok: true });
  permissions.getEffectivePermissionsForUser = async () => ({ codes: ["system.operational_log"] });
  alerts.notifyModbusHttpDeviceRecovered = async () => {};
  alerts.notifyModbusHttpDeviceFailed = async () => {};
  db.query = async (sql, params) => {
    if (sql.includes("INSERT INTO operational_events")) {
      await sleep(4);
      return [{ id: ++writes, created_at: params[0] }];
    }
    if (sql.includes("FROM devices d") && sql.includes("model_config")) {
      return Array.from({ length: 6 }, (_, index) => ({
        id: index + 1, config: device(`di-${index}`),
      }));
    }
    throw new Error("Unexpected query in monitoring load fixture");
  };
  client.timeout = 100;
  client.ensureConnection = async ({ host }) => ({
    isOpen: true,
    readCoils: async (_address, length) => {
      await sleep(8);
      return { data: Array(length).fill(false) };
    },
    readHoldingRegisters: async () => {
      await sleep(host.startsWith("slow-") ? 250 : 20);
      return { data: [1] };
    },
  });
}

async function waitFor(condition, label) {
  const deadline = performance.now() + 2_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
}

async function verifySocketReconnect(socket, server, received) {
  for (let attempt = 0; attempt < 2; attempt++) {
    socket.connect();
    await waitFor(() => server.sockets.sockets.get(socket.id)?.rooms.has("perm:system.operational_log"), "event room");
    const id = await recordEvent({ source: "load-fixture", event_kind: "state_change" });
    assert.ok(id);
    await waitFor(() => received.has(id), `event ${id}`);
    if (attempt === 0) socket.disconnect();
  }
}

const round = (value) => Math.round(value * 10) / 10;

async function run(scenario, load) {
  installFixtures();
  const app = express();
  app.use(responseHandler);
  app.use("/api/monitoring", monitoringRoutes);
  const server = http.createServer(app);
  const io = websocket.initializeWebSocket(server);
  let socket;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    socket = connectSocket(baseUrl, {
      auth: { token }, transports: ["websocket"], autoConnect: false, reconnection: false,
    });
    const received = new Set();
    socket.on("operational-event:new", ({ id }) => received.add(id));
    let snapshotUnavailableUntil = 0;
    let snapshotTimeouts = 0;
    const snapshot = createSystemSnapshotMonitor({
      systemKey: "hvac", loggerName: "load-fixture",
      getSnapshot: async () => {
        const host = performance.now() < snapshotUnavailableUntil ? "slow-snapshot" : "snapshot";
        const [value] = await client.readHoldingRegisters(0, 1, device(host)).catch((error) => {
          if (error.code === C.MODBUS_READ_TIMEOUT) snapshotTimeouts++;
          throw error;
        });
        return { items: [{ systemId: 1, zoneId: "1", raw: { value } }] };
      },
    });
    await snapshot.check();
    const baseline = snapshotCache.getSnapshot("hvac");
    assert.ok(baseline);
    monitoring.registerMonitoringTask("fixture-di", () =>
      planner.pollControllers({ registerTypes: new Set(["coil"]), broadcastStatus: false }), 1000);
    monitoring.registerMonitoringTask("fixture-snapshot", snapshot.check, 1000);
    monitoring.startMonitoring({ quiet: true });

    const samples = [];
    const diagnostics = async () => {
      const start = performance.now();
      const response = await fetch(`${baseUrl}/api/monitoring/diagnostics`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 200);
      const { data } = await response.json();
      return { ...data, httpMs: performance.now() - start };
    };
    let sampling = true;
    const sample = (async () => {
      while (sampling) {
        samples.push(await diagnostics());
        await sleep(50);
      }
    })().then(() => null, (error) => error);
    const started = performance.now();
    snapshotUnavailableUntil = started + load.snapshotOutageMs;
    const direct = Promise.allSettled(Array.from({ length: load.direct }, (_, index) =>
      client.readHoldingRegisters(0, 1, device(`${index % 5 === 0 ? "slow" : "fast"}-direct-${index}`)),
    ));
    const batches = Promise.all(Array.from({ length: load.batches }, (_, group) =>
      batch.batchRead(Array.from({ length: load.groups }, (_, index) => ({
        ...device(`${index % 6 === 0 ? "slow" : "fast"}-batch-${group}-${index}`),
        registerType: "holding", address: 0,
      }))),
    ));
    const writesDuringLoad = (async () => {
      for (let index = 0; index < 20; index++) {
        assert.ok(await recordEvent({ source: "load-fixture", event_kind: "state_change" }));
        await sleep(30);
      }
    })();
    let results;
    try {
      results = await Promise.allSettled([
        direct, batches, writesDuringLoad, verifySocketReconnect(socket, io, received),
        sleep(1600),
      ]);
      if (load.snapshotOutageMs) {
        assert.ok(snapshotTimeouts > 0, "the snapshot fixture must see a timeout");
        await waitFor(
          () => snapshotCache.getSnapshot("hvac").fetchedAt !== baseline.fetchedAt,
          "snapshot recovery",
        );
      }
    } finally {
      sampling = false;
      const sampleError = await sample;
      await monitoring.stopMonitoring();
      if (sampleError) throw sampleError;
    }
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    const [directResult, batchResult] = results.map(({ value }) => value);
    const directFailures = directResult.filter((result) => result.status === "rejected");
    assert.equal(directFailures.length, Math.ceil(load.direct / 5));
    assert.ok(directFailures.every((result) => result.reason.code === C.MODBUS_READ_TIMEOUT));
    const batchFailures = batchResult.flat().filter((result) => !result.ok);
    assert.equal(batchFailures.length, load.batches * Math.ceil(load.groups / 6));
    const latest = (await diagnostics()).modbus;
    assert.equal(latest.activeCount, 0);
    assert.equal(latest.queueSize, 0);
    assert.ok(latest.priority.startedCount > 0);
    const httpTimes = samples.map(({ httpMs }) => httpMs).sort((a, b) => a - b);
    console.log(JSON.stringify({
      scenario, load, elapsedMs: round(performance.now() - started),
      directTimeouts: directFailures.length, batchTimeouts: batchFailures.length, snapshotTimeouts,
      writes, wsEventsReceived: received.size, wsConnections: 2,
      peakQueueSize: latest.peakQueueSize,
      peakStandardOldestWaitMs: Math.max(...samples.map(({ modbus }) => modbus.standard.oldestWaitMs ?? 0)),
      standardWaitP95Ms: latest.standard.waitP95Ms, priorityWaitP95Ms: latest.priority.waitP95Ms,
      maxSnapshotAgeMs: Math.max(...samples.flatMap(({ snapshots }) => snapshots.map(({ ageMs }) => ageMs))),
      finalQueueSize: latest.queueSize,
      diagnosticsSamples: samples.length, diagnosticsP95Ms: round(httpTimes[Math.ceil(httpTimes.length * 0.95) - 1]),
    }, null, 2));
  } finally {
    socket?.disconnect();
    await monitoring.stopMonitoring();
    websocket.closeWebSocket();
    await db.pool.end();
  }
}

const scenario = process.argv[2] ?? "mixed";
if (!Object.hasOwn(scenarios, scenario)) {
  console.error("Usage: node scripts/integration/monitoring-load.js [mixed|burst]");
  process.exitCode = 1;
} else {
  run(scenario, scenarios[scenario]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
