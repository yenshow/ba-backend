/**
 * 備份 CSV 報表共用工具（繁中本地化）
 */

/** 與營運日／警報日界線一致（runtimeConfigService FIXED_ALERT_ROLLOVER_TZ） */
const REPORT_TZ = "Asia/Taipei";

function formatDateTimeZhTW(dateString) {
  if (!dateString) return "";
  const d = new Date(dateString);
  return d.toLocaleString("zh-TW", {
    timeZone: REPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDateZhTW(dateString) {
  if (!dateString) return "";
  return new Date(dateString).toLocaleDateString("zh-TW", {
    timeZone: REPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function getDeviceConfigDisplay(deviceConfig) {
  if (!deviceConfig) return "";
  const config =
    typeof deviceConfig === "string"
      ? JSON.parse(deviceConfig || "{}")
      : deviceConfig;
  return String(config.host ?? "").trim() || "";
}

function formatZoneLocation(zoneName, locationName) {
  return [zoneName, locationName].filter(Boolean).join("-") || "";
}

module.exports = {
  formatDateTimeZhTW,
  formatDateZhTW,
  getDeviceConfigDisplay,
  formatZoneLocation,
};
