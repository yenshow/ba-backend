/**
 * 能源彙總排程（由 licenseRuntimeService 依 energy 授權啟停）
 */
const logger = require("../../utils/logger").createLogger(
  "energyAggregationScheduler",
);
const energyAggregationService = require("./energyAggregationService");

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

const startEnergyAggregationScheduler = () => {
  if (started) {
    return { started: true, alreadyRunning: true };
  }
  started = true;

  const runHourAgg = async () => {
    try {
      await energyAggregationService.computeAndSaveHour();
    } catch (err) {
      logger.warn("能源彙總 hour 失敗", { error: err.message });
    }
  };

  setImmediate(async () => {
    await runHourAgg();
    try {
      await energyAggregationService.backfillTodayHours();
    } catch (err) {
      logger.warn("能源彙總 hour 補寫失敗", { error: err.message });
    }
  });

  hourAggIntervalId = setInterval(runHourAgg, 60 * 60 * 1000);
  partialHourAggIntervalId = setInterval(
    () =>
      energyAggregationService
        .upsertPartialCurrentHour()
        .catch((err) =>
          logger.warn("能源彙總 partial hour 失敗", { error: err.message }),
        ),
    15 * 60 * 1000,
  );

  setImmediate(() =>
    energyAggregationService
      .backfillRecentDays(7)
      .catch((err) => logger.warn("能源彙總 day 補寫失敗", { error: err.message })),
  );

  dayAggTimeoutId = scheduleDailyAtUtc(0, 5, () =>
    energyAggregationService.computeAndSaveDay(),
  );

  logger.info("能源彙總排程已啟用");
  return { started: true, alreadyRunning: false };
};

const stopEnergyAggregationScheduler = () => {
  if (hourAggIntervalId) clearInterval(hourAggIntervalId);
  if (partialHourAggIntervalId) clearInterval(partialHourAggIntervalId);
  if (dayAggTimeoutId) clearTimeout(dayAggTimeoutId);
  if (dayAggIntervalId) clearInterval(dayAggIntervalId);
  hourAggIntervalId = null;
  partialHourAggIntervalId = null;
  dayAggTimeoutId = null;
  dayAggIntervalId = null;
  started = false;
  return { stopped: true };
};

module.exports = {
  startEnergyAggregationScheduler,
  stopEnergyAggregationScheduler,
};
