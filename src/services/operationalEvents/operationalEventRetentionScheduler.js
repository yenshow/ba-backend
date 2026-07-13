/**
 * 營運事件保留天數清理排程（預設每日 Asia/Taipei 00:10）
 */
const { DateTime } = require("luxon");
const logger = require("../../utils/logger");
const config = require("../../config");
const operationalEventService = require("./operationalEventService");

const retentionLogger = logger.createLogger("operationalEventRetention");

let retentionTimer = null;

function scheduleNextPurge() {
  if (retentionTimer) {
    clearTimeout(retentionTimer);
    retentionTimer = null;
  }

  const tz = "Asia/Taipei";
  const now = DateTime.now().setZone(tz);
  let next = now.set({ hour: 0, minute: 10, second: 0, millisecond: 0 });
  if (next <= now) {
    next = next.plus({ days: 1 });
  }
  const ms = Math.max(1000, Math.ceil(next.diff(now).as("milliseconds")));

  retentionTimer = setTimeout(async () => {
    retentionTimer = null;
    try {
      await operationalEventService.purgeExpiredEvents(
        config.operationalEvents?.retentionDays,
      );
    } catch (err) {
      retentionLogger.warn("營運事件清理失敗", {
        error: err?.message || String(err),
      });
    } finally {
      scheduleNextPurge();
    }
  }, ms);
}

function startOperationalEventRetentionScheduler() {
  scheduleNextPurge();
  retentionLogger.info("營運事件保留清理排程已啟用", {
    retentionDays: config.operationalEvents?.retentionDays ?? 90,
  });
  return stopOperationalEventRetentionScheduler;
}

function stopOperationalEventRetentionScheduler() {
  if (retentionTimer) {
    clearTimeout(retentionTimer);
    retentionTimer = null;
  }
}

module.exports = {
  startOperationalEventRetentionScheduler,
  stopOperationalEventRetentionScheduler,
};
