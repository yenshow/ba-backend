const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setImmediate: flush } = require("node:timers/promises");
const monitoring = require("../../src/services/monitoring/backgroundMonitor");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const tick = async (timers, ms) => {
  timers.tick(ms);
  await flush();
};

test("fast monitoring proceeds independently while another task is in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const slow = deferred();
  const starts = [];
  const status = monitoring.syncMonitoringTasks([
    { taskId: "fast", systemName: "fast", taskFunction: () => starts.push(Date.now()), options: 1000 },
    { taskId: "slow", systemName: "slow", taskFunction: () => slow.promise, options: 15000 },
  ]);
  try {
    assert.equal(status.startedNow, true);
    await tick(t.mock.timers, 200);
    await tick(t.mock.timers, 1000);
    await tick(t.mock.timers, 1000);
    assert.deepEqual(starts, [200, 1200, 2200]);
    const [fastStatus, slowStatus] = monitoring.getMonitoringStatus().tasks;
    assert.equal(fastStatus.lastDurationMs, 0);
    assert.equal(fastStatus.lastRunAgeMs, 0);
    assert.equal(slowStatus.lastScheduleDelayMs, 200);
    assert.equal(slowStatus.runningForMs, 2000);
    assert.equal(slowStatus.lastRunAgeMs, null);
  } finally {
    slow.resolve();
    await monitoring.stopMonitoring();
    monitoring.syncMonitoringTasks([]);
  }
});

test("stop drains even removed tasks and does not restart the scheduler", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const work = deferred();
  let calls = 0;
  const desired = [{
    taskId: "switchable",
    systemName: "switchable",
    options: 1000,
    taskFunction: () => {
      calls += 1;
      return work.promise;
    },
  }];
  monitoring.syncMonitoringTasks(desired);
  try {
    await tick(t.mock.timers, 200);
    monitoring.syncMonitoringTasks([]);
    monitoring.syncMonitoringTasks(desired);
    await tick(t.mock.timers, 1500);
    assert.equal(calls, 1);

    let stopped = false;
    const draining = monitoring.stopMonitoring().then(() => { stopped = true; });
    await flush();
    assert.equal(stopped, false);
    work.resolve();
    await draining;
    await tick(t.mock.timers, 2000);
    assert.equal(calls, 1);
    assert.equal(monitoring.getMonitoringStatus().isRunning, false);

    monitoring.startMonitoring({ quiet: true });
    await tick(t.mock.timers, 200);
    assert.equal(calls, 2);
  } finally {
    work.resolve();
    await monitoring.stopMonitoring();
    monitoring.syncMonitoringTasks([]);
  }
});
