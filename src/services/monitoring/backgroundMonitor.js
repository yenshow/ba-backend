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

let monitoringTimer = null;
let stopRequested = false;
let resolveStopped = null;

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

  monitoringTasks.push({
    taskId: resolvedTaskId,
    systemName,
    taskFunction,
    baseIntervalMs,
    minIntervalMs,
    maxIntervalMs,
    currentIntervalMs: baseIntervalMs,
    nextRunAtMs: Date.now(),
    lastRun: null,
    lastStartedAtMs: 0,
    isRunning: false,
    errorCount: 0,
  });

  monitorLogger.debug(`已註冊監控任務: ${systemName}`);
}

async function runTask(task) {
  const startTime = Date.now();
  task.lastStartedAtMs = startTime;
  task.isRunning = true;

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

    task.nextRunAtMs = Date.now() + task.currentIntervalMs;
    return { ok: true, durationMs: Date.now() - startTime };
  } catch (error) {
    task.errorCount++;
    const duration = Date.now() - startTime;

    monitorLogger.warn(
      `${task.systemName} 監控失敗（錯誤次數: ${task.errorCount}, 耗時: ${duration}ms）`,
      { error: error.message },
    );

    if (task.errorCount >= 5) {
      monitorLogger.warn(
        `${task.systemName} 連續 ${task.errorCount} 次監控失敗，請檢查系統狀態`,
      );
    }

    task.currentIntervalMs = task.baseIntervalMs;
    task.nextRunAtMs = Date.now() + task.baseIntervalMs;
    return { ok: false, durationMs: duration, error };
  } finally {
    task.isRunning = false;
  }
}

function getDueTasks(now) {
  return monitoringTasks.filter((t) => !t.isRunning && t.nextRunAtMs <= now);
}

function getNextWakeAtMs(now) {
  if (monitoringTasks.length === 0) return now + 60_000;
  let next = Infinity;
  for (const t of monitoringTasks) {
    const when = t.isRunning ? now + t.currentIntervalMs : t.nextRunAtMs;
    if (when < next) next = when;
  }
  if (!Number.isFinite(next)) return now + 60_000;
  return Math.max(now + SCHEDULER_TICK_MIN_MS, next);
}

async function runSchedulerTick() {
  if (monitoringTasks.length === 0) {
    return;
  }

  if (stopRequested) {
    return;
  }

  const startTime = Date.now();

  try {
    const now = Date.now();
    const due = getDueTasks(now);
    if (due.length === 0) {
      return;
    }

    const dueSummary = `本輪執行任務數: ${due.length}（${due
      .map((t) => t.systemName)
      .join("、")}）`;
    monitorLogger.debug(dueSummary);

    await Promise.all(due.map((task) => runTask(task)));

    const totalDuration = Date.now() - startTime;
    monitorLogger.debug(`本輪到期任務完成（總耗時: ${totalDuration}ms）`);
  } catch (error) {
    monitorLogger.error("執行監控任務時發生未預期的錯誤", {
      error: error?.message || error,
      stack: error?.stack,
    });
  } finally {
    if (stopRequested && !monitoringTimer && resolveStopped) {
      const resolve = resolveStopped;
      resolveStopped = null;
      stopRequested = false;
      resolve();
    }
  }
}

function scheduleNextTick() {
  if (stopRequested) return;
  if (monitoringTimer) clearTimeout(monitoringTimer);
  const now = Date.now();
  const wakeAt = getNextWakeAtMs(now);
  const delay = Math.max(SCHEDULER_TICK_MIN_MS, wakeAt - now);
  monitoringTimer = setTimeout(async () => {
    try {
      await runSchedulerTick();
    } finally {
      scheduleNextTick();
    }
  }, delay);
}

function startMonitoring({ quiet = false } = {}) {
  if (monitoringTimer) {
    monitorLogger.warn("監控服務已在運行中");
    return;
  }

  stopRequested = false;

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

  scheduleNextTick();
}

function stopMonitoring() {
  if (monitoringTimer) {
    clearTimeout(monitoringTimer);
    monitoringTimer = null;
    monitorLogger.info("背景監控服務已停止");
  }

  stopRequested = true;

  const anyRunning = monitoringTasks.some((t) => t.isRunning);
  if (!anyRunning) {
    stopRequested = false;
    return Promise.resolve();
  }

  if (resolveStopped) {
    return new Promise((resolve) => {
      const previousResolve = resolveStopped;
      resolveStopped = () => {
        previousResolve();
        resolve();
      };
    });
  }

  return new Promise((resolve) => {
    resolveStopped = resolve;
  });
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
  }

  const wasRunning = !!monitoringTimer;
  const taskNames = monitoringTasks.map((task) => task.systemName).filter(Boolean);
  if (monitoringTasks.length === 0) {
    if (wasRunning) {
      stopMonitoring();
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
  }

  return {
    taskCount: monitoringTasks.length,
    taskIds: getRegisteredTaskIds(),
    taskNames,
    schedulerRunning: !!monitoringTimer,
    startedNow,
  };
}

function getMonitoringStatus() {
  const now = Date.now();
  return {
    isRunning: !!monitoringTimer,
    taskCount: monitoringTasks.length,
    tasks: monitoringTasks.map((task) => ({
      systemName: task.systemName,
      lastRun: task.lastRun,
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
