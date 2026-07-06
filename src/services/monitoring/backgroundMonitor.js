/**
 * 背景監控服務
 * 統一管理所有系統的背景監控任務
 * 支持多系統擴展，易於添加新系統的監控邏輯
 */

const logger = require("../../utils/logger");

const monitorLogger = logger.createLogger("backgroundMonitor");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

/**
 * Mode A（自適應監控）：
 * - 每個任務獨立排程 nextRunAt（不再固定每 15 秒全量跑）
 * - 成功 → 漸進放慢（直到 maxInterval）
 * - 失敗 → 指數退避（直到 maxBackoffInterval）
 * - 同一任務不重疊執行
 */
const clampInt = (n, min, max) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
};

const BASE_INTERVAL_MS = clampInt(15_000, 1000, 10 * 60 * 1000);
const MIN_INTERVAL_MS = clampInt(BASE_INTERVAL_MS, 1000, 10 * 60 * 1000);
const MAX_INTERVAL_MS = clampInt(60_000, MIN_INTERVAL_MS, 60 * 60 * 1000);
const MAX_BACKOFF_INTERVAL_MS = clampInt(
  5 * 60 * 1000,
  MIN_INTERVAL_MS,
  60 * 60 * 1000,
);
const BACKOFF_FACTOR = 2;
const SUCCESS_RAMP_STEP_MS = clampInt(5000, 0, 10 * 60 * 1000);

// 監控任務註冊表
const monitoringTasks = [];

let monitoringTimer = null;
let stopRequested = false;
let resolveStopped = null;

const SCHEDULER_TICK_MIN_MS = 200;

/**
 * 註冊監控任務
 * @param {string} systemName - 系統名稱（用於日誌）
 * @param {Function} taskFunction - 監控任務函數（返回 Promise）
 * @param {number|object} intervalOrOptions - 可選 interval（毫秒）或 options
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

  const minIntervalMs = clampInt(
    opts.minIntervalMs ?? MIN_INTERVAL_MS,
    1000,
    10 * 60 * 1000,
  );
  const maxIntervalMs = clampInt(
    opts.maxIntervalMs ?? MAX_INTERVAL_MS,
    minIntervalMs,
    60 * 60 * 1000,
  );
  const baseIntervalMs = clampInt(
    opts.baseIntervalMs ?? BASE_INTERVAL_MS,
    minIntervalMs,
    maxIntervalMs,
  );
  const maxBackoffIntervalMs = clampInt(
    opts.maxBackoffIntervalMs ?? MAX_BACKOFF_INTERVAL_MS,
    baseIntervalMs,
    60 * 60 * 1000,
  );

  monitoringTasks.push({
    taskId: resolvedTaskId,
    systemName,
    taskFunction,
    baseIntervalMs,
    minIntervalMs,
    maxIntervalMs,
    maxBackoffIntervalMs,
    currentIntervalMs: baseIntervalMs,
    nextRunAtMs: Date.now(),
    lastRun: null,
    lastStartedAtMs: 0,
    isRunning: false,
    errorCount: 0,
  });

  monitorLogger.debug(`已註冊監控任務: ${systemName}`);
}

/**
 * 執行單個監控任務
 */
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

    // success: 漸進放慢（直到 maxIntervalMs）
    const suggested =
      hint && typeof hint === "object" && Number.isFinite(hint.nextIntervalMs)
        ? clampInt(hint.nextIntervalMs, task.minIntervalMs, task.maxIntervalMs)
        : null;
    if (suggested != null) {
      task.currentIntervalMs = suggested;
    } else if (SUCCESS_RAMP_STEP_MS > 0) {
      task.currentIntervalMs = Math.min(
        task.maxIntervalMs,
        Math.max(
          task.baseIntervalMs,
          task.currentIntervalMs + SUCCESS_RAMP_STEP_MS,
        ),
      );
    } else {
      task.currentIntervalMs = Math.max(
        task.baseIntervalMs,
        task.currentIntervalMs,
      );
    }

    task.nextRunAtMs = Date.now() + task.currentIntervalMs;
    return { ok: true, durationMs: Date.now() - startTime };
  } catch (error) {
    task.errorCount++;
    const duration = Date.now() - startTime;

    monitorLogger.warn(
      `${task.systemName} 監控失敗（錯誤次數: ${task.errorCount}, 耗時: ${duration}ms）`,
      { error: error.message },
    );

    // 如果連續錯誤超過 5 次，記錄警告
    if (task.errorCount >= 5) {
      monitorLogger.warn(
        `${task.systemName} 連續 ${task.errorCount} 次監控失敗，請檢查系統狀態`,
      );
    }

    // failure: 指數退避（直到 maxBackoffIntervalMs）
    const next = Math.min(
      task.maxBackoffIntervalMs,
      Math.max(
        task.baseIntervalMs,
        Math.floor(task.currentIntervalMs * BACKOFF_FACTOR),
      ),
    );
    task.currentIntervalMs = next;
    task.nextRunAtMs = Date.now() + next;
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

    // 並行執行「到期」任務（同一任務不重疊）
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

/**
 * 啟動背景監控服務
 */
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
      `背景監控已啟動（Mode A 自適應排程；任務: ${taskNames}；共 ${monitoringTasks.length} 個）`,
    );
  }

  // 立即安排一次 tick（各任務 nextRunAtMs 初始化為 now）
  scheduleNextTick();
}

/**
 * 停止背景監控服務
 */
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

/**
 * 取得監控狀態
 */
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
