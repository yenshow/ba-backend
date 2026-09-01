const { DateTime } = require("luxon");
const logger = require("./logger");
const { computeNextDailyRunAt } = require("../services/externalIntegration/exportSchedule");

/**
 * 每日本地時刻排程（遞迴 setTimeout，避免 setInterval 漂移）
 * @param {{
 *   name: string,
 *   getSchedule: () => { enabled?: boolean, timezone?: string, hour?: number, minute?: number },
 *   runJob: () => Promise<void>,
 *   runOnStart?: boolean,
 *   minDelayMs?: number,
 * }} options
 */
function createDailyLocalScheduler(options) {
  const {
    name,
    getSchedule,
    runJob,
    runOnStart = false,
    minDelayMs = 1000,
  } = options;
  const schedLogger = logger.createLogger(`dailyLocalScheduler:${name}`);
  let timer = null;
  let isRunning = false;

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const formatDailyTime = (hour, minute) =>
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  const scheduleNext = (onError) => {
    stop();
    const schedule = getSchedule() || {};
    if (schedule.enabled === false) {
      schedLogger.info("排程已停用");
      return;
    }

    const timezone = schedule.timezone || "Asia/Taipei";
    const hour = Number.isFinite(Number(schedule.hour))
      ? Number(schedule.hour)
      : 0;
    const minute = Number.isFinite(Number(schedule.minute))
      ? Number(schedule.minute)
      : 0;
    const timeHHmm = formatDailyTime(hour, minute);
    const next = computeNextDailyRunAt(timeHHmm, timezone);
    const now = DateTime.now().setZone(timezone);
    const ms = Math.max(
      minDelayMs,
      Math.ceil(next.diff(now).as("milliseconds")),
    );

    timer = setTimeout(async () => {
      timer = null;
      if (isRunning) {
        schedLogger.warn("前次任務尚未結束，略過本次觸發");
        scheduleNext(onError);
        return;
      }
      isRunning = true;
      try {
        await runJob();
      } catch (err) {
        if (typeof onError === "function") {
          onError(err);
        } else {
          schedLogger.warn("任務失敗", {
            error: err?.message || String(err),
          });
        }
      } finally {
        isRunning = false;
        scheduleNext(onError);
      }
    }, ms);

    schedLogger.info("已排程下次執行", {
      dailyLocalTime: timeHHmm,
      timezone,
      nextAt: next.toISO(),
    });
  };

  const startScheduler = () => {
    const onError = (err) =>
      schedLogger.error("任務失敗", {
        error: err?.message || String(err),
      });

    scheduleNext(onError);
    if (runOnStart) {
      setImmediate(() => {
        if (isRunning) return;
        isRunning = true;
        Promise.resolve()
          .then(() => runJob())
          .catch(onError)
          .finally(() => {
            isRunning = false;
          });
      });
    }

    const schedule = getSchedule() || {};
    schedLogger.info("排程已啟動", {
      enabled: schedule.enabled !== false,
      dailyLocalTime: formatDailyTime(
        schedule.hour ?? 0,
        schedule.minute ?? 0,
      ),
      timezone: schedule.timezone || "Asia/Taipei",
    });

    return {
      stop,
      reschedule: () => scheduleNext(onError),
      runNow: async () => {
        if (isRunning) return;
        isRunning = true;
        try {
          await runJob();
        } finally {
          isRunning = false;
        }
      },
    };
  };

  return {
    startScheduler,
  };
}

module.exports = {
  createDailyLocalScheduler,
};
