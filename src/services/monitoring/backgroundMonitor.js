/**
 * 背景監控服務
 * 固定間隔排程；任務可回傳 { nextIntervalMs }（電梯 idle/moving）
 * 同一任務不重疊執行；成功／失敗皆回到 base（或 hint）
 */

const logger = require("../../utils/logger");
const { STANDARD_POLL_MS } = require("../../config/realtimeTiming");

const monitorLogger = logger.createLogger("backgroundMonitor");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const clampInt = (n, min, max) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
};

const BASE_INTERVAL_MS = STANDARD_POLL_MS;
const SCHEDULER_TICK_MIN_MS = 200;

const monitoringTasks = [];
const runningTasks = new Map();

let monitoringTimer = null;
let scheduledWakeAtMs = null;
let schedulerRunning = false;

/**
 * @param {string} systemName
 * @param {Function} taskFunction
 * @param {number|object|null} intervalOrOptions
 * @param {string|null} taskId
 */
function registerMonitoringTask(
  systemName,
  taskFunction,
  intervalOrOptions = null,
  taskId = null,
) {
  if (typeof taskFunction !== "function") {
    throwApiError(C.MONITOR_TASK_INVALID, `監控任務必須是一個函數: ${systemName}`);
  }

  const opts =
    intervalOrOptions && typeof intervalOrOptions === "object"
      ? intervalOrOptions
      : intervalOrOptions != null
        ? { baseIntervalMs: intervalOrOptions }
        : {};

  const resolvedTaskId = taskId || opts.taskId || systemName;

  const baseIntervalMs = clampInt(
    opts.baseIntervalMs ?? BASE_INTERVAL_MS,
    1000,
    10 * 60 * 1000,
  );
  const minIntervalMs = clampInt(
    opts.minIntervalMs ?? baseIntervalMs,
    1000,
    10 * 60 * 1000,
  );
  const maxIntervalMs = clampInt(
    opts.maxIntervalMs ?? baseIntervalMs,
    minIntervalMs,
    60 * 60 * 1000,
  );

  const startOffsetMs = clampInt(opts.startOffsetMs ?? 0, 0, 60_000);

  monitoringTasks.push({
    taskId: resolvedTaskId,
    systemName,
    taskFunction,
    baseIntervalMs,
    minIntervalMs,
    maxIntervalMs,
    currentIntervalMs: baseIntervalMs,
    nextRunAtMs: Date.now() + startOffsetMs,
    lastRun: null,
    lastStartedAtMs: null,
    lastScheduleDelayMs: null,
    lastDurationMs: null,
    errorCount: 0,
  });

  monitorLogger.debug(`已註冊監控任務: ${systemName}`);
  scheduleNextTick();
}

async function runTask(task) {
  const startTime = Date.now();
  task.lastStartedAtMs = startTime;
  task.lastScheduleDelayMs = Math.max(0, startTime - task.nextRunAtMs);
  try {
    monitorLogger.debug(`開始執行: ${task.systemName}`);

    const hint = await task.taskFunction();
    task.lastRun = new Date();
    task.errorCount = 0;

    const duration = Date.now() - startTime;
    monitorLogger.debug(`${task.systemName} 監控完成（耗時: ${duration}ms）`);

    const suggested =
      hint && typeof hint === "object" && Number.isFinite(hint.nextIntervalMs)
        ? clampInt(hint.nextIntervalMs, task.minIntervalMs, task.maxIntervalMs)
        : null;
    task.currentIntervalMs =
      suggested != null ? suggested : task.baseIntervalMs;
  } catch (error) {
    task.errorCount++;
    const duration = Date.now() - startTime;

    monitorLogger.warn(
      `${task.systemName} 監控失敗（錯誤次數: ${task.errorCount}, 耗時: ${duration}ms）`,
      { error: error?.message ?? String(error) },
    );

    if (task.errorCount >= 5) {
      monitorLogger.warn(
        `${task.systemName} 連續 ${task.errorCount} 次監控失敗，請檢查系統狀態`,
      );
    }

    task.currentIntervalMs = task.baseIntervalMs;
  } finally {
    const finishedAt = Date.now();
    task.lastDurationMs = Math.max(0, finishedAt - startTime);
    task.nextRunAtMs = finishedAt + task.currentIntervalMs;
  }
}

function clearScheduledTick() {
  if (monitoringTimer) clearTimeout(monitoringTimer);
  monitoringTimer = null;
  scheduledWakeAtMs = null;
}

function runSchedulerTick() {
  clearScheduledTick();
  if (!schedulerRunning) return;
  const now = Date.now();
  const due = monitoringTasks.filter(
    (task) => !runningTasks.has(task.taskId) && task.nextRunAtMs <= now,
  );
  if (due.length > 0) {
    monitorLogger.debug(`本輪執行任務數: ${due.length}（${due
      .map((t) => t.systemName)
      .join("、")}）`);
    for (const task of due) {
      const run = Promise.resolve()
        .then(() => runTask(task))
        .catch((error) => {
          monitorLogger.error("執行監控任務時發生未預期的錯誤", {
            error: error?.message ?? String(error),
            stack: error?.stack,
          });
        })
        .finally(() => {
          runningTasks.delete(task.taskId);
          scheduleNextTick();
        });
      runningTasks.set(task.taskId, run);
    }
  }
  scheduleNextTick();
}

function scheduleNextTick() {
  if (!schedulerRunning) return;
  let nextRunAtMs = Infinity;
  for (const task of monitoringTasks) {
    if (!runningTasks.has(task.taskId)) {
      nextRunAtMs = Math.min(nextRunAtMs, task.nextRunAtMs);
    }
  }
  if (scheduledWakeAtMs === nextRunAtMs) return;
  clearScheduledTick();
  if (!Number.isFinite(nextRunAtMs)) return;

  const now = Date.now();
  const delay = Math.max(SCHEDULER_TICK_MIN_MS, nextRunAtMs - now);
  scheduledWakeAtMs = nextRunAtMs;
  monitoringTimer = setTimeout(runSchedulerTick, delay);
}

function startMonitoring({ quiet = false } = {}) {
  if (schedulerRunning) {
    monitorLogger.warn("監控服務已在運行中");
    return;
  }

  if (monitoringTasks.length === 0) {
    monitorLogger.warn("沒有註冊任何監控任務，跳過啟動");
    return;
  }

  const taskNames = monitoringTasks
    .map((t) => t.systemName)
    .filter(Boolean)
    .join("、");

  if (!quiet) {
    monitorLogger.info(
      `背景監控已啟動（固定分層間隔；任務: ${taskNames}；共 ${monitoringTasks.length} 個）`,
    );
  }

  schedulerRunning = true;
  scheduleNextTick();
}

async function stopMonitoring() {
  if (schedulerRunning) {
    monitorLogger.info("背景監控服務已停止");
  }
  schedulerRunning = false;
  clearScheduledTick();
  await Promise.allSettled(runningTasks.values());
}

function getRegisteredTaskIds() {
  return monitoringTasks.map((task) => task.taskId);
}

function syncMonitoringTasks(desiredTasks) {
  const desired = Array.isArray(desiredTasks) ? desiredTasks : [];
  const desiredIds = new Set(
    desired.map((task) => task.taskId).filter(Boolean),
  );

  for (let i = monitoringTasks.length - 1; i >= 0; i -= 1) {
    if (!desiredIds.has(monitoringTasks[i].taskId)) {
      monitoringTasks.splice(i, 1);
    }
  }

  const existingIds = new Set(monitoringTasks.map((task) => task.taskId));
  for (const task of desired) {
    if (!task?.taskId || existingIds.has(task.taskId)) {
      continue;
    }
    registerMonitoringTask(
      task.systemName,
      task.taskFunction,
      task.options,
      task.taskId,
    );
    existingIds.add(task.taskId);
  }

  const wasRunning = schedulerRunning;
  const taskNames = monitoringTasks.map((task) => task.systemName).filter(Boolean);
  if (monitoringTasks.length === 0) {
    if (wasRunning) {
      void stopMonitoring();
    }
    return {
      taskCount: 0,
      taskIds: [],
      taskNames: [],
      schedulerRunning: false,
      startedNow: false,
    };
  }

  const startedNow = !wasRunning;
  if (startedNow) {
    startMonitoring({ quiet: true });
  } else {
    scheduleNextTick();
  }

  return {
    taskCount: monitoringTasks.length,
    taskIds: getRegisteredTaskIds(),
    taskNames,
    schedulerRunning,
    startedNow,
  };
}

function getMonitoringStatus() {
  const now = Date.now();
  return {
    isRunning: schedulerRunning,
    taskCount: monitoringTasks.length,
    tasks: monitoringTasks.map((task) => ({
      taskId: task.taskId,
      systemName: task.systemName,
      lastRun: task.lastRun,
      lastRunAgeMs: task.lastRun === null ? null : Math.max(0, now - task.lastRun.getTime()),
      runningForMs: runningTasks.has(task.taskId) && task.lastStartedAtMs !== null
        ? Math.max(0, now - task.lastStartedAtMs)
        : null,
      lastScheduleDelayMs: task.lastScheduleDelayMs,
      lastDurationMs: task.lastDurationMs,
      errorCount: task.errorCount,
      currentIntervalMs: task.currentIntervalMs,
      nextRunInMs: Math.max(0, (task.nextRunAtMs || now) - now),
    })),
  };
}

module.exports = {
  registerMonitoringTask,
  syncMonitoringTasks,
  startMonitoring,
  stopMonitoring,
  getMonitoringStatus,
  BASE_INTERVAL_MS,
};
