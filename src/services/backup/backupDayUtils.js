/**
 * 備份按曆日分桶（時區 SSOT：ALERT_DAILY_ROLLOVER_TZ）
 */
const { DateTime } = require("luxon");
const runtimeConfigService = require("../platform/runtimeConfigService");

const getBackupTimezone = () =>
  runtimeConfigService.getAlerts().dailyRolloverTimezone || "Asia/Taipei";

const subtractDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
};

const getRetentionCutoffs = (retention) => {
  const archiveAfterDays = Math.max(1, retention.archiveAfterDays);
  const onlineRetentionDays = Math.max(
    archiveAfterDays + 1,
    retention.onlineRetentionDays,
  );
  return {
    archiveBeforeDate: subtractDays(archiveAfterDays),
    deleteBeforeDate: subtractDays(onlineRetentionDays),
    timezone: getBackupTimezone(),
    archiveAfterDays,
    onlineRetentionDays,
  };
};

const toDayKey = (value, timezone) => {
  const dt = DateTime.fromJSDate(new Date(value), { zone: timezone });
  if (!dt.isValid) return null;
  return dt.toFormat("yyyy-MM-dd");
};

const dayKeyToUtcRange = (dayKey, timezone) => {
  const start = DateTime.fromFormat(dayKey, "yyyy-MM-dd", { zone: timezone }).startOf(
    "day",
  );
  const end = start.plus({ days: 1 });
  return {
    start: start.toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
  };
};

const groupRowsByDayKey = (rows, dateField, timezone) => {
  const groups = new Map();
  for (const row of rows || []) {
    const raw = row?.[dateField];
    if (!raw) continue;
    const key = toDayKey(raw, timezone);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
};

const buildDayCsvFilename = (tableName, dayKey) => `${tableName}_${dayKey}.csv`;

module.exports = {
  getRetentionCutoffs,
  toDayKey,
  dayKeyToUtcRange,
  groupRowsByDayKey,
  buildDayCsvFilename,
};
