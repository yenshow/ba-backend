/**
 * ISAPI 事件表備份 CSV（扁平列，供歸檔）
 */
const { formatDateTimeZhTW } = require("./reportFormatUtils");

function rowsToFlatCsv(rows, headers, rowMapper) {
  return {
    sections: [
      {
        title: "",
        headers,
        rows: rows.map(rowMapper),
      },
    ],
  };
}

function transformIsapiAccessEventsToReportFormat(rows) {
  return rowsToFlatCsv(
    rows,
    ["設備IP", "事件時間", "事件類型", "附圖數", "附圖路徑", "payload摘要"],
    (r) => {
      let summary = "";
      try {
        const p =
          typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
        summary = p?.personName || p?.employeeNoString || "";
      } catch {
        summary = "";
      }
      return {
        設備IP: r.device_ip ?? "",
        事件時間: formatDateTimeZhTW(r.event_time),
        事件類型: r.event_type ?? "",
        附圖數: r.file_count ?? 0,
        附圖路徑: r.backup_picture_path ?? r.picture_path ?? "",
        payload摘要: summary,
      };
    },
  );
}

function transformIsapiFaceContrastEventsToReportFormat(rows) {
  return rowsToFlatCsv(
    rows,
    [
      "區域",
      "地點",
      "設備IP",
      "事件時間",
      "事件類型",
      "相似度",
      "工號",
      "姓名",
      "比對結果",
      "附圖路徑",
    ],
    (r) => ({
      區域: r.zone_name ?? "",
      地點: r.location_name ?? "",
      設備IP: r.device_ip ?? "",
      事件時間: formatDateTimeZhTW(r.event_time),
      事件類型: r.event_type ?? "",
      相似度: r.similarity ?? "",
      工號: r.employee_no ?? "",
      姓名: r.person_name ?? "",
      比對結果: r.matched ? "成功" : "失敗",
      附圖路徑: r.backup_picture_path ?? r.picture_path ?? "",
    }),
  );
}

function transformIsapiPeopleCountingToReportFormat(rows) {
  return rowsToFlatCsv(
    rows,
    [
      "區域",
      "地點",
      "事件時間",
      "設備ID",
      "區域名稱",
      "進場累計",
      "出場累計",
      "進場增量",
      "出場增量",
    ],
    (r) => ({
      區域: r.zone_name ?? "",
      地點: r.location_name ?? "",
      事件時間: formatDateTimeZhTW(r.event_time),
      設備ID: r.device_id ?? "",
      區域名稱: r.region_name ?? "",
      進場累計: r.enter ?? "",
      出場累計: r.exit ?? "",
      進場增量: r.enter_delta ?? 0,
      出場增量: r.exit_delta ?? 0,
    }),
  );
}

module.exports = {
  transformIsapiAccessEventsToReportFormat,
  transformIsapiFaceContrastEventsToReportFormat,
  transformIsapiPeopleCountingToReportFormat,
};
