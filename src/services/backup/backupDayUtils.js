/**
 * 備份按曆日分桶（時區 SSOT：ALERT_DAILY_ROLLOVER_TZ）
 */
const { DateTime } = require("luxon");
const runtimeConfigService = require("../platform/runtimeConfigService");

const getBackupTimezone = () =>
  runtimeConfigService.getAlerts().dailyRolloverTimezone || "Asia/Taipei";

const getRetentionCutoffs = (retention) => {
  const archiveAfterDays = Math.max(1, retention.archiveAfterDays);
  const onlineRetentionDays = Math.max(
    archiveAfterDays + 1,
    retention.onlineRetentionDays,
  );
  const timezone = getBackupTimezone();
  const today = DateTime.now().setZone(timezone).startOf("day");
  return {
    archiveBeforeDate: today.minus({ days: archiveAfterDays }).toJSDate(),
    archiveStartDate: today.minus({ days: onlineRetentionDays }).toJSDate(),
    timezone,
    archiveAfterDays,
    onlineRetentionDays,
  };
};

const toDayKey = (value, timezone) => {
  const dt = DateTime.fromJSDate(new Date(value), { zone: timezone });
  if (!dt.isValid) return null;
  return dt.toFormat("yyyy-MM-dd");
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
const buildDayXlsxFilename = (tableName, dayKey) => `${tableName}_${dayKey}.xlsx`;

module.exports = {
  getRetentionCutoffs,
  toDayKey,
  groupRowsByDayKey,
  buildDayCsvFilename,
  buildDayXlsxFilename,
};
