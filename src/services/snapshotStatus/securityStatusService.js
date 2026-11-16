/**
 * 保全：Modbus DI 快照（門禁設備狀態不進本快照，僅平面圖 DI）
 */
const alertService = require("../alerts/alertService");
const {
  normalizeSmokeEmergencySnapshotRaw,
} = require("../monitoring/systemSnapshotMonitorFactory");
const {
  deriveRunningAlarmUiStatus,
} = require("./modbusSnapshotHelpers");
const {
  createModbusSnapshotStatusService,
} = require("./createModbusSnapshotStatusService");

function resolveSecurityFields(system) {
  const cfg = system.config || {};
  return {
    deviceId: cfg.deviceId,
    modbus: cfg.modbus,
    equipmentKind: cfg.equipmentKind || "sensor",
    viewCategory: cfg.viewCategory || "perimeter",
    statusPoints: cfg.statusPoints || {},
  };
}

module.exports = createModbusSnapshotStatusService({
  systemType: "security",
  loggerName: "securityStatusService",
  alertSource: alertService.ALERT_SOURCES.SECURITY,
  alertSyncKey: "security",
  readErrorMessage: "無法讀取保全設備資料",
  resolveFields: resolveSecurityFields,
  mergeRaw: (raw) => normalizeSmokeEmergencySnapshotRaw(raw),
  deriveUiStatus: deriveRunningAlarmUiStatus,
  useAllSettled: true,
  fallbackEquipmentKind: "sensor",
  fallbackViewCategory: "perimeter",
});
