const { DateTime } = require("luxon");
const logger = require("../../utils/logger");
const db = require("../../database/db");
const recordExportService = require("./recordExportService");
const { runExternalSyncOnce } = require("./externalSyncService");
const {
  ZONE,
  PUSH_MODE_REALTIME,
  computeNextDailyRunAt,
  computeNextExportRunAt,
  normalizeScheduleFreq,
  clampPushIntervalSeconds,
  nextRealtimeRunAt,
} = require("./exportSchedule");

function createFixedScheduler({ logger: schedLogger, loadJobs }) {
  const timers = new Map();
  let stopped = false;

  const clearAll = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  const armTimer = (job, nextAt) => {
    if (timers.has(job.key)) {
      clearTimeout(timers.get(job.key));
      timers.delete(job.key);
    }

    const nowMs = DateTime.now().setZone(ZONE).toMillis();
    const delayMs = Math.max(1000, nextAt.toMillis() - nowMs);
    schedLogger?.info?.("已排程任務", {
      key: job.key,
      nextAt: nextAt.toISO(),
      inMs: delayMs,
    });

    const timer = setTimeout(async () => {
      timers.delete(job.key);
      try {
        await job.run();
      } catch (err) {
        schedLogger?.warn?.("排程任務執行失敗", {
          key: job.key,
          error: err?.message || String(err),
        });
      }
      if (stopped) return;
      if (typeof job.nextAfterRun === "function") {
        try {
          armTimer(job, job.nextAfterRun());
        } catch (err) {
          schedLogger?.warn?.("重排單一任務失敗", {
            key: job.key,
            error: err?.message || String(err),
          });
        }
        return;
      }
      await scheduleAll();
    }, delayMs);

    timers.set(job.key, timer);
  };

  const scheduleAll = async () => {
    clearAll();
    if (stopped) return;

    let jobs = [];
    try {
      jobs = await loadJobs();
    } catch (err) {
      schedLogger?.warn?.("載入排程失敗", { error: err?.message || String(err) });
      return;
    }

    if (jobs.length === 0) {
      schedLogger?.info?.("無排程任務，略過");
      return;
    }

    for (const job of jobs) {
      armTimer(job, job.nextAt);
    }
  };

  const start = () => {
    stopped = false;
    void scheduleAll();
    return {
      stop: () => {
        stopped = true;
        clearAll();
      },
      reschedule: () => void scheduleAll(),
    };
  };

  return { start, scheduleNext: scheduleAll };
}

const externalSyncLogger = logger.createLogger("externalSyncScheduler");
const recordExportLogger = logger.createLogger("recordExportScheduler");

function startExternalSync() {
  const scheduler = createFixedScheduler({
    logger: externalSyncLogger,
    loadJobs: async () => {
      const rows = await db.query(
        `SELECT event_type, push_mode, push_time, push_interval_seconds
         FROM external_sync_configs
         ORDER BY id ASC`,
        [],
      );
      if (!rows?.length) return [];

      const jobs = [];
      const byTime = new Map();

      for (const row of rows) {
        if (String(row.push_mode ?? "").trim().toLowerCase() === PUSH_MODE_REALTIME) {
          const intervalSeconds = clampPushIntervalSeconds(row.push_interval_seconds);
          const eventType = row.event_type;
          jobs.push({
            key: `external-sync-rt-${eventType}`,
            nextAt: nextRealtimeRunAt(intervalSeconds),
            nextAfterRun: () => nextRealtimeRunAt(intervalSeconds),
            run: async () => {
              try {
                await runExternalSyncOnce(eventType);
              } catch (err) {
                externalSyncLogger.warn("資料庫對接執行失敗", {
                  eventType,
                  error: err?.message || String(err),
                });
              }
            },
          });
          continue;
        }

        const time = String(row.push_time ?? "").slice(0, 5);
        if (!/^\d{2}:\d{2}$/.test(time)) {
          externalSyncLogger.warn("略過無效固定推播時間", {
            eventType: row.event_type,
            pushTime: row.push_time,
          });
          continue;
        }
        if (!byTime.has(time)) byTime.set(time, []);
        byTime.get(time).push(row.event_type);
      }

      for (const [timeHHmm, eventTypes] of byTime.entries()) {
        jobs.push({
          key: `external-sync-${timeHHmm}`,
          nextAt: computeNextDailyRunAt(timeHHmm),
          nextAfterRun: () => computeNextDailyRunAt(timeHHmm),
          run: async () => {
            for (const eventType of eventTypes) {
              try {
                await runExternalSyncOnce(eventType);
              } catch (err) {
                externalSyncLogger.warn("資料庫對接執行失敗", {
                  eventType,
                  error: err?.message || String(err),
                });
              }
            }
          },
        });
      }

      return jobs;
    },
  });

  return scheduler.start();
}

function startRecordExport() {
  const scheduler = createFixedScheduler({
    logger: recordExportLogger,
    loadJobs: async () => {
      const rules = await db.query(
        `SELECT id, export_time, schedule_freq, schedule_day
         FROM record_export_rules WHERE enabled = TRUE ORDER BY id ASC`,
        [],
      );
      if (!rules?.length) return [];

      const byKey = new Map();
      for (const rule of rules) {
        const time = String(rule.export_time).slice(0, 5);
        const freq = normalizeScheduleFreq(rule.schedule_freq) || "daily";
        const day = rule.schedule_day != null ? Number(rule.schedule_day) : 0;
        const key = `record-export-${freq}-${day || 0}-${time}`;
        if (!byKey.has(key)) {
          byKey.set(key, {
            key,
            freq,
            day: rule.schedule_day,
            timeHHmm: time,
            ruleIds: [],
          });
        }
        byKey.get(key).ruleIds.push(rule.id);
      }

      return [...byKey.values()].map((group) => {
        const resolveNext = () =>
          computeNextExportRunAt({
            scheduleFreq: group.freq,
            scheduleDay: group.day,
            timeHHmm: group.timeHHmm,
          });
        return {
          key: group.key,
          nextAt: resolveNext(),
          nextAfterRun: resolveNext,
          run: async () => {
            for (const ruleId of group.ruleIds) {
              try {
                await recordExportService.runRecordExportRule(ruleId);
              } catch (err) {
                recordExportLogger.warn("記錄轉存規則執行失敗", {
                  ruleId,
                  error: err?.message || String(err),
                });
              }
            }
          },
        };
      });
    },
  });

  return scheduler.start();
}

module.exports = {
  startExternalSync,
  startRecordExport,
};
