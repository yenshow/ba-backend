/**
 * 環境讀數備份 CSV 報表格式
 * 區域-地點、設備配置，不顯示 ID
 */

const {
  formatDateTimeZhTW,
  getDeviceConfigDisplay,
  formatZoneLocation,
} = require("./reportFormatUtils");

const PARAM_LABELS = {
  temperature: "溫度",
  humidity: "濕度",
  pm25: "PM2.5",
  pm10: "PM10",
  co2: "CO2",
  noise: "噪音值",
  tvoc: "TVOC",
  hcho: "HCHO",
  wind: "風速",
};

function transformEnvironmentReadingsToReportFormat(rows) {
  return rows.map((r) => {
    const data =
      typeof r.data === "object" ? r.data : r.data ? JSON.parse(r.data) : {};

    const base = {
      系統來源: "環境",
      "區域-地點": formatZoneLocation(r.zone_name, r.location_name),
      設備配置: getDeviceConfigDisplay(r.device_config),
      記錄時間: formatDateTimeZhTW(r.recorded_at),
    };

    for (const [key, value] of Object.entries(data)) {
      const label = PARAM_LABELS[key] ?? key;
      base[label] = value != null ? value : "";
    }

    return base;
  });
}

module.exports = {
  transformEnvironmentReadingsToReportFormat,
};
