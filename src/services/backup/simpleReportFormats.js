/**
 * 薄備份 CSV 報表（警報／環境／能源／營運事件／梯控）
 * 厚報表（人流／車輛）仍見 peopleCountingReportFormat、vehicleAccessReportFormat。
 */

const {
  formatDateTimeZhTW,
  getDeviceConfigDisplay,
  formatZoneLocation,
} = require("./reportFormatUtils");
const { getAlertSourceLabel } = require("../../access/catalog");
const {
  getParameterDisplayName,
} = require("../../constants/environmentParameterCatalog");

const ALERT_TYPE_LABELS = { offline: "離線", error: "錯誤", threshold: "閾值" };
const ALERT_SEVERITY_LABELS = {
  warning: "警告",
  error: "錯誤",
  critical: "嚴重",
};
const ALERT_STATUS_LABELS = {
  active: "未解決",
  resolved: "已解決",
  ignored: "已忽視",
};

function formatTypeSeverity(type, severity) {
  const t = ALERT_TYPE_LABELS[type] ?? type;
  const s = ALERT_SEVERITY_LABELS[severity] ?? severity;
  return `${t}（${s}）`;
}

function transformAlertsToReportFormat(alerts) {
  return (alerts || []).map((alert) => ({
    系統來源: getAlertSourceLabel(alert.source),
    "區域-地點": formatZoneLocation(alert.zone_name, alert.source_name),
    設備類型: alert.device_type_name ?? "",
    設備配置: getDeviceConfigDisplay(alert.device_config),
    類型與程度: formatTypeSeverity(alert.alert_type, alert.severity),
    狀態: ALERT_STATUS_LABELS[alert.status] ?? alert.status,
    訊息: alert.message ?? "",
    創建時間: formatDateTimeZhTW(alert.created_at),
    更新時間: formatDateTimeZhTW(alert.updated_at),
    忽視時間: formatDateTimeZhTW(alert.ignored_at),
    忽視者: alert.ignored_by_username ?? "",
  }));
}

const ENV_FRACTION_DIGITS = 1;

function roundEnvParamValue(value) {
  if (value == null || typeof value !== "number" || Number.isNaN(value)) {
    return "";
  }
  const rounded =
    Math.round(value * Math.pow(10, ENV_FRACTION_DIGITS)) /
    Math.pow(10, ENV_FRACTION_DIGITS);
  return rounded.toFixed(ENV_FRACTION_DIGITS);
}

function transformEnvironmentReadingsToReportFormat(rows) {
  return (rows || []).map((r) => {
    const data =
      typeof r.data === "object" ? r.data : r.data ? JSON.parse(r.data) : {};

    const base = {
      "區域-地點": formatZoneLocation(r.zone_name, r.location_name),
      記錄時間: formatDateTimeZhTW(r.recorded_at),
    };

    for (const [key, value] of Object.entries(data)) {
      const label = getParameterDisplayName(key) || key;
      base[label] = roundEnvParamValue(value);
    }

    return base;
  });
}

function transformEnergyReadingsToReportFormat(rows) {
  return (rows || []).map((r) => {
    const data =
      typeof r.data === "object"
        ? r.data
        : r.data
          ? JSON.parse(String(r.data))
          : {};
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
      設備ID: r.device_id ?? "",
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
  transformAlertsToReportFormat,
  transformEnvironmentReadingsToReportFormat,
  transformEnergyReadingsToReportFormat,
  transformOperationalEventsToReportFormat,
  transformLadderSdkEventsToReportFormat,
};
