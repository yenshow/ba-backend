/**
 * 梯控 SDK 事件備份 CSV
 */
const { formatDateTimeZhTW } = require("./reportFormatUtils");

function transformLadderSdkEventsToReportFormat(rows) {
  return (rows || []).map((r) => {
    let payloadSummary = "";
    try {
      const p =
        typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
      payloadSummary = p?.eventDescription || p?.description || "";
    } catch {
      payloadSummary = "";
    }
    return {
      設備名稱: r.device_name ?? "",
      設備IP: r.device_ip ?? "",
      事件時間: formatDateTimeZhTW(r.event_time),
      Major: r.major ?? "",
      Minor: r.minor ?? "",
      事件名稱: r.event_name ?? "",
      樓層: r.floor ?? "",
      卡號: r.card_no ?? "",
      人員: r.person_name ?? "",
      工號: r.employee_no ?? "",
      payload摘要: payloadSummary,
    };
  });
}

module.exports = {
  transformLadderSdkEventsToReportFormat,
};
