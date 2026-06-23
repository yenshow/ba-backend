/**
 * 環境彙總排程（hour / partial hour / day）
 * 由 licenseRuntimeService 依 environment 授權啟停。
 */
const logger = require("../../utils/logger").createLogger(
  "environmentAggregationScheduler",
);
const environmentAggregationService = require("./environmentAggregationService");

let hourAggIntervalId = null;
let partialHourAggIntervalId = null;
let dayAggTimeoutId = null;
let dayAggIntervalId = null;
let started = false;

const scheduleDailyAtUtc = (hour, minute, fn) => {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      minute,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  const delay = Math.max(0, next.getTime() - now.getTime());
  const safeRun = () => Promise.resolve(fn()).catch(() => {});
  return setTimeout(() => {
    void safeRun();
    dayAggIntervalId = setInterval(() => void safeRun(), 24 * 60 * 60 * 1000);
  }, delay);
};

const startEnvironmentAggregationScheduler = () => {
  if (started) {
    return { started: true, alreadyRunning: true };
  }
  started = true;

  const runHourAgg = async () => {
    try {
      await environmentAggregationService.computeAndSaveHour();
    } catch (err) {
      logger.warn("環境彙總 hour 執行失敗", { error: err.message });
    }
  };

  const runTodayHourBackfill = async () => {
    try {
      await environmentAggregationService.backfillTodayHours();
      logger.info("環境彙總 hour 今日補寫完成");
    } catch (err) {
      logger.warn("環境彙總 hour 今日補寫失敗", { error: err.message });
    }
  };

  const runDayAggBackfill = async () => {
    try {
      await environmentAggregationService.backfillRecentDays(7);
      logger.info("環境彙總 day 補寫完成（最近 7 天）");
    } catch (err) {
      logger.warn("環境彙總 day 補寫失敗", { error: err.message });
    }
  };

  const runDayAgg = async () => {
    try {
      await environmentAggregationService.computeAndSaveDay();
    } catch (err) {
      logger.warn("環境彙總 day 執行失敗", { error: err.message });
    }
  };

  setImmediate(async () => {
    await runHourAgg();
    await runTodayHourBackfill();
  });
  hourAggIntervalId = setInterval(runHourAgg, 60 * 60 * 1000);
  partialHourAggIntervalId = setInterval(
    () =>
      environmentAggregationService
        .upsertPartialCurrentHour()
        .catch((err) =>
          logger.warn("環境彙總 partial hour 失敗", { error: err.message }),
        ),
    15 * 60 * 1000,
  );
  logger.info("環境彙總排程已啟用（每小時 + 每 15 分鐘 partial hour）");

  setImmediate(() => void runDayAggBackfill());
  dayAggTimeoutId = scheduleDailyAtUtc(0, 5, runDayAgg);
  logger.info("環境彙總排程已啟用（每日 UTC 00:05，day bucket）");

  return { started: true, alreadyRunning: false };
};

const stopEnvironmentAggregationScheduler = () => {
  if (!started) {
    return { stopped: false };
  }

  if (hourAggIntervalId) {
    clearInterval(hourAggIntervalId);
    hourAggIntervalId = null;
  }
  if (partialHourAggIntervalId) {
    clearInterval(partialHourAggIntervalId);
    partialHourAggIntervalId = null;
  }
  if (dayAggTimeoutId) {
    clearTimeout(dayAggTimeoutId);
    dayAggTimeoutId = null;
  }
  if (dayAggIntervalId) {
    clearInterval(dayAggIntervalId);
    dayAggIntervalId = null;
  }

  started = false;
  logger.info("環境彙總排程已停止");
  return { stopped: true };
};

module.exports = {
  startEnvironmentAggregationScheduler,
  stopEnvironmentAggregationScheduler,
};
