const { DateTime } = require("luxon");
const logger = require("../../utils/logger");
const db = require("../../database/db");
const recordExportService = require("./recordExportService");
const { runExternalSyncOnce } = require("./externalSyncService");
const {
  computeNextDailyRunAt,
  computeNextExportRunAt,
  normalizeScheduleFreq,
} = require("./exportSchedule");

function createFixedScheduler({ logger: schedLogger, loadJobs }) {
  const timers = new Map();
  let stopped = false;

  const clearAll = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  const scheduleNext = async () => {
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

    const zone = "Asia/Taipei";
    const nowMs = DateTime.now().setZone(zone).toMillis();

    for (const job of jobs) {
      const next = job.nextAt;
      const delayMs = Math.max(1000, next.toMillis() - nowMs);
      schedLogger?.info?.("已排程任務", {
        key: job.key,
        nextAt: next.toISO(),
        inMs: delayMs,
      });

      const timer = setTimeout(async () => {
        try {
          await job.run();
        } catch (err) {
          schedLogger?.warn?.("排程任務執行失敗", {
            key: job.key,
            error: err?.message || String(err),
          });
        }
        if (!stopped) await scheduleNext();
      }, delayMs);

      timers.set(job.key, timer);
    }
  };

  const start = () => {
    stopped = false;
    void scheduleNext();
    return {
      stop: () => {
        stopped = true;
        clearAll();
      },
      reschedule: () => void scheduleNext(),
    };
  };

  return { start, scheduleNext };
}

const externalSyncLogger = logger.createLogger("externalSyncScheduler");
const recordExportLogger = logger.createLogger("recordExportScheduler");

let externalSyncHandle = null;
let recordExportHandle = null;

function startExternalSync() {
  const scheduler = createFixedScheduler({
    logger: externalSyncLogger,
    loadJobs: async () => {
      const rows = await db.query(
        "SELECT event_type, push_time FROM external_sync_configs ORDER BY id ASC",
        [],
      );
      if (!rows?.length) return [];

      const byTime = new Map();
      for (const row of rows) {
        const time = String(row.push_time).slice(0, 5);
        if (!byTime.has(time)) byTime.set(time, []);
        byTime.get(time).push(row.event_type);
      }

      return [...byTime.entries()].map(([timeHHmm, eventTypes]) => ({
        key: `external-sync-${timeHHmm}`,
        nextAt: computeNextDailyRunAt(timeHHmm),
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
      }));
    },
  });

  externalSyncHandle = scheduler.start();
  return externalSyncHandle;
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

      return [...byKey.values()].map((group) => ({
        key: group.key,
        nextAt: computeNextExportRunAt({
          scheduleFreq: group.freq,
          scheduleDay: group.day,
          timeHHmm: group.timeHHmm,
        }),
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
      }));
    },
  });

  recordExportHandle = scheduler.start();
  return recordExportHandle;
}

module.exports = {
  startExternalSync,
  startRecordExport,
};
