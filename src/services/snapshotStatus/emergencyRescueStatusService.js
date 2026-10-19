/**
 * 緊急求救：依 location_systems 設定讀取 Modbus 並合成 uiStatus
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

function resolveEmergencyRescueFields(system) {
  const cfg = system.config || {};
  return {
    deviceId: cfg.deviceId,
    modbus: cfg.modbus,
    equipmentKind: cfg.equipmentKind || "pump",
    viewCategory: cfg.viewCategory || "sos",
    statusPoints: cfg.statusPoints || {},
  };
}

module.exports = createModbusSnapshotStatusService({
  systemType: "emergency_rescue",
  loggerName: "emergencyRescueStatusService",
  alertSource: alertService.ALERT_SOURCES.EMERGENCY_RESCUE,
  alertSyncKey: "emergency_rescue",
  readErrorMessage: "無法讀取緊急求救設備資料",
  resolveFields: resolveEmergencyRescueFields,
  mergeRaw: (raw) => normalizeSmokeEmergencySnapshotRaw(raw),
  deriveUiStatus: deriveRunningAlarmUiStatus,
  useAllSettled: false,
  fallbackEquipmentKind: "pump",
  fallbackViewCategory: "sos",
});
