/**
 * 能源讀數備份 CSV（對齊環境：僅 raw，不備 aggregated）
 */
const { formatDateTimeZhTW } = require("./reportFormatUtils");

function transformEnergyReadingsToReportFormat(rows) {
  return (rows || []).map((r) => {
    const data =
      typeof r.data === "object" ? r.data : r.data ? JSON.parse(String(r.data)) : {};
    const base = {
      設備名稱: r.device_name ?? "",
      設備ID: r.device_id ?? "",
      記錄時間: formatDateTimeZhTW(r.recorded_at),
    };
    for (const [key, value] of Object.entries(data)) {
      if (value != null && typeof value === "number" && !Number.isNaN(value)) {
        base[key] = String(Math.round(value * 1000) / 1000);
      } else {
        base[key] = value == null ? "" : String(value);
      }
    }
    return base;
  });
}

module.exports = {
  transformEnergyReadingsToReportFormat,
};
