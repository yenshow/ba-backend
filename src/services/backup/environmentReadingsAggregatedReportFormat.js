/**
 * 環境讀數彙總備份 CSV 格式（欄位：區域-地點、彙總類型、區間起點、數值；數值小數一位）
 */

const { formatDateTimeZhTW, formatZoneLocation } = require("./reportFormatUtils");
const {
  PARAM_LABELS,
  roundParamValue,
} = require("./environmentReadingsReportFormat");

const BUCKET_LABELS = { hour: "小時", day: "日", month: "月" };

function transformEnvironmentReadingsAggregatedToReportFormat(rows) {
  return rows.map((r) => {
    const data = typeof r.data === "object" ? r.data : (r.data ? JSON.parse(r.data) : {});
    const base = {
      "區域-地點": formatZoneLocation(r.zone_name, r.location_name),
      彙總類型: BUCKET_LABELS[r.bucket_type] || r.bucket_type,
      區間起點: formatDateTimeZhTW(r.bucket_at),
    };
    for (const [key, value] of Object.entries(data)) {
      const label = PARAM_LABELS[key] ?? key;
      base[label] = roundParamValue(key, value);
    }
    return base;
  });
}

module.exports = {
  transformEnvironmentReadingsAggregatedToReportFormat,
};
