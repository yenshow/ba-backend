/**
 * 環境讀數備份 CSV 報表格式
 * 欄位：區域-地點、記錄時間、數值欄位（不顯示設備配置／系統來源）
 * 數值四捨五入至小數一位（與儲存／趨勢一致）
 */

const { formatDateTimeZhTW, formatZoneLocation } = require("./reportFormatUtils");
const { getParameterDisplayName } = require("../../constants/environmentParameterCatalog");

const FRACTION_DIGITS = 1;

function roundParamValue(key, value) {
  if (value == null || typeof value !== "number" || Number.isNaN(value)) return "";
  const rounded = Math.round(value * Math.pow(10, FRACTION_DIGITS)) / Math.pow(10, FRACTION_DIGITS);
  return rounded.toFixed(FRACTION_DIGITS);
}

function transformEnvironmentReadingsToReportFormat(rows) {
  return rows.map((r) => {
    const data =
      typeof r.data === "object" ? r.data : r.data ? JSON.parse(r.data) : {};

    const base = {
      "區域-地點": formatZoneLocation(r.zone_name, r.location_name),
      記錄時間: formatDateTimeZhTW(r.recorded_at),
    };

    for (const [key, value] of Object.entries(data)) {
      const label = getParameterDisplayName(key) || key;
      base[label] = roundParamValue(key, value);
    }

    return base;
  });
}

module.exports = {
  transformEnvironmentReadingsToReportFormat,
};
