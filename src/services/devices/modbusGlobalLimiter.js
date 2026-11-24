/** 跨系統共用 Modbus 連線與讀取容量，為 DI/DO 保留席位。 */

const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");

const GLOBAL_CONCURRENCY = 12;
const RESERVED_PRIORITY_SLOTS = 2;
const STANDARD_CONCURRENCY = GLOBAL_CONCURRENCY - RESERVED_PRIORITY_SLOTS;
const WAIT_SAMPLE_LIMIT = 128;
const priorityContext = new AsyncLocalStorage();

const createLane = () => ({
  active: 0,
  queue: [],
  started: 0,
  waitSamples: [],
});
const standard = createLane();
const priority = createLane();
let peakQueueSize = 0;

const queueSize = () => standard.queue.length + priority.queue.length;

function next() {
  if (standard.active + priority.active >= GLOBAL_CONCURRENCY) return;
  const lane = priority.queue.length > 0 ? priority : standard;
  if (lane === standard && standard.active >= STANDARD_CONCURRENCY) return;
  const item = lane.queue.shift();
  if (!item) return;

  lane.active++;
  lane.waitSamples[lane.started % WAIT_SAMPLE_LIMIT] = performance.now() - item.queuedAt;
  lane.started++;
  Promise.resolve()
    .then(() => priorityContext.run(lane === priority, item.fn))
    .finally(() => {
      lane.active--;
      next();
    })
    .then(item.resolve, item.reject);
}

const run = (fn) =>
  new Promise((resolve, reject) => {
    const lane = priorityContext.getStore() === true ? priority : standard;
    lane.queue.push({ fn, resolve, reject, queuedAt: performance.now() });
    next();
    peakQueueSize = Math.max(peakQueueSize, queueSize());
  });

const runWithPriority = (fn) => priorityContext.run(true, fn);

function describeLane(lane, now) {
  const sorted = [...lane.waitSamples].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  return {
    activeCount: lane.active,
    queueSize: lane.queue.length,
    oldestWaitMs: lane.queue.length ? Math.round(now - lane.queue[0].queuedAt) : null,
    startedCount: lane.started,
    waitSampleCount: sorted.length,
    waitP95Ms: p95 === undefined ? null : Math.round(p95),
  };
}

function getStats() {
  const now = performance.now();
  return {
    concurrency: GLOBAL_CONCURRENCY,
    reservedPrioritySlots: RESERVED_PRIORITY_SLOTS,
    activeCount: standard.active + priority.active,
    queueSize: queueSize(),
    peakQueueSize,
    standard: describeLane(standard, now),
    priority: describeLane(priority, now),
  };
}

module.exports = { run, runWithPriority, getStats, STANDARD_CONCURRENCY };

