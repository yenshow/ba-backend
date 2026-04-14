const { DateTime } = require("luxon");
const config = require("../../config");
const logger = require("../../utils/logger");
const alertService = require("./alertService");

const rolloverLogger = logger.createLogger("alertRollover");

let rolloverTimer = null;

/**
 * 依設定時區之本地時刻排程下一次執行（遞迴 setTimeout，避免 setInterval 漂移）
 */
function scheduleNextRollover() {
  if (rolloverTimer) {
    clearTimeout(rolloverTimer);
    rolloverTimer = null;
  }
  if (!config.alerts.dailyRolloverEnabled) {
    return;
  }

  const tz = config.alerts.dailyRolloverTimezone;
  const h = config.alerts.dailyRolloverLocalHour;
  const m = config.alerts.dailyRolloverLocalMinute;

  const now = DateTime.now().setZone(tz);
  let next = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (next <= now) {
    next = next.plus({ days: 1 });
  }
  const ms = Math.max(1000, Math.ceil(next.diff(now).as("milliseconds")));

  rolloverTimer = setTimeout(async () => {
    rolloverTimer = null;
    try {
      const r = await alertService.resolveAllActiveForDailyRollover();
      if (r.resolvedCount > 0) {
        rolloverLogger.info("警報日界線結案完成", {
          resolvedCount: r.resolvedCount,
          timezone: tz,
        });
      }
    } catch (err) {
      rolloverLogger.warn("警報日界線結案失敗", {
        error: err?.message || String(err),
      });
    } finally {
      scheduleNextRollover();
    }
  }, ms);
}

function startAlertDailyRolloverScheduler() {
  if (!config.alerts.dailyRolloverEnabled) {
    rolloverLogger.info("警報日界線排程已停用（ALERT_DAILY_ROLLOVER_ENABLED=false）");
    return () => {};
  }
  scheduleNextRollover();
  return stopAlertDailyRolloverScheduler;
}

function stopAlertDailyRolloverScheduler() {
  if (rolloverTimer) {
    clearTimeout(rolloverTimer);
    rolloverTimer = null;
  }
}

module.exports = {
  startAlertDailyRolloverScheduler,
  stopAlertDailyRolloverScheduler,
};
