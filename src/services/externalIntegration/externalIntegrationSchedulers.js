const { DateTime } = require("luxon");
const logger = require("../../utils/logger");
const db = require("../../database/db");
const recordExportService = require("./recordExportService");
const { runExternalSyncOnce } = require("./externalSyncService");

function computeNextRunAt(timeHHmm, zone = "Asia/Taipei") {
  const [hh, mm] = String(timeHHmm || "00:00")
    .trim()
    .split(":")
    .map((v) => Number(v));
  const now = DateTime.now().setZone(zone);
  let next = now.set({ hour: hh || 0, minute: mm || 0, second: 0, millisecond: 0 });
  if (next <= now.plus({ seconds: 1 })) {
    next = next.plus({ days: 1 });
  }
  return next;
}

function createFixedDailyScheduler({ logger: schedLogger, loadJobs }) {
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
      const next = computeNextRunAt(job.timeHHmm, zone);
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
  const scheduler = createFixedDailyScheduler({
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
        timeHHmm,
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
  const scheduler = createFixedDailyScheduler({
    logger: recordExportLogger,
    loadJobs: async () => {
      const rules = await db.query(
        "SELECT id, export_time FROM record_export_rules WHERE enabled = TRUE ORDER BY id ASC",
        [],
      );
      if (!rules?.length) return [];

      const byTime = new Map();
      for (const rule of rules) {
        const time = String(rule.export_time).slice(0, 5);
        if (!byTime.has(time)) byTime.set(time, []);
        byTime.get(time).push(rule.id);
      }

      return [...byTime.entries()].map(([timeHHmm, ruleIds]) => ({
        key: `record-export-${timeHHmm}`,
        timeHHmm,
        run: async () => {
          for (const ruleId of ruleIds) {
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
