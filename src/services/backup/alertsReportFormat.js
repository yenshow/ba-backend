/**
 * 警報備份 CSV 報表格式
 * 欄位：系統來源、區域-地點、設備類型、設備配置、類型與程度、狀態、訊息、創建時間、更新時間、忽視時間、忽視者
 */

const {
  formatDateTimeZhTW,
  getDeviceConfigDisplay,
  formatZoneLocation,
} = require("./reportFormatUtils");

const { getAlertSourceLabel } = require("../../access/catalog");

const TYPE_LABELS = { offline: "離線", error: "錯誤", threshold: "閾值" };
const SEVERITY_LABELS = { warning: "警告", error: "錯誤", critical: "嚴重" };
const STATUS_LABELS = {
  active: "未解決",
  resolved: "已解決",
  ignored: "已忽視",
};

function formatTypeSeverity(type, severity) {
  const t = TYPE_LABELS[type] ?? type;
  const s = SEVERITY_LABELS[severity] ?? severity;
  return `${t}（${s}）`;
}

function alertToReportRow(alert) {
  return {
    系統來源: getAlertSourceLabel(alert.source),
    "區域-地點": formatZoneLocation(alert.zone_name, alert.source_name),
    設備類型: alert.device_type_name ?? "",
    設備配置: getDeviceConfigDisplay(alert.device_config),
    類型與程度: formatTypeSeverity(alert.alert_type, alert.severity),
    狀態: STATUS_LABELS[alert.status] ?? alert.status,
    訊息: alert.message ?? "",
    創建時間: formatDateTimeZhTW(alert.created_at),
    更新時間: formatDateTimeZhTW(alert.updated_at),
    忽視時間: formatDateTimeZhTW(alert.ignored_at),
    忽視者: alert.ignored_by_username ?? "",
  };
}

function transformAlertsToReportFormat(alerts) {
  return alerts.map(alertToReportRow);
}

module.exports = {
  transformAlertsToReportFormat,
};
