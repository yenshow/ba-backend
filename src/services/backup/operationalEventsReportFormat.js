/**
 * 營運事件備份 CSV
 */
const { formatDateTimeZhTW } = require("./reportFormatUtils");

function transformOperationalEventsToReportFormat(rows) {
  return (rows || []).map((r) => {
    let payloadSummary = "";
    try {
      const p =
        typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
      if (p && typeof p === "object") {
        payloadSummary = JSON.stringify(p).slice(0, 500);
      }
    } catch {
      payloadSummary = "";
    }
    return {
      發生時間: formatDateTimeZhTW(r.created_at),
      來源: r.source ?? "",
      事件類型: r.event_kind ?? "",
      摘要: r.message ?? "",
      區域: r.zone_name ?? "",
      地點: r.location_name ?? "",
      設備: r.device_name ?? "",
      設備ID: r.device_id ?? "",
      bit_key: r.bit_key ?? "",
      位址: r.address ?? "",
      舊值: r.old_value == null ? "" : String(r.old_value),
      新值: r.new_value == null ? "" : String(r.new_value),
      操作者: r.actor_username ?? "",
      ref_table: r.ref_table ?? "",
      ref_id: r.ref_id ?? "",
      payload摘要: payloadSummary,
    };
  });
}

module.exports = {
  transformOperationalEventsToReportFormat,
};
