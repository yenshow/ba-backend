/**
 * 煙霧警報：依 location_systems 設定讀取 Modbus 並合成 uiStatus
 * API `raw`：觸發合併為 running
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

function resolveSmokeFields(system) {
  const cfg = system.config || {};
  return {
    deviceId: cfg.deviceId,
    modbus: cfg.modbus,
    equipmentKind: cfg.equipmentKind || "detector",
    viewCategory: cfg.viewCategory || "smoke",
    statusPoints: cfg.statusPoints || {},
  };
}

module.exports = createModbusSnapshotStatusService({
  systemType: "smoke_alarm",
  loggerName: "smokeAlarmStatusService",
  alertSource: alertService.ALERT_SOURCES.SMOKE_ALARM,
  alertSyncKey: "smoke_alarm",
  readErrorMessage: "無法讀取煙霧警報設備資料",
  resolveFields: resolveSmokeFields,
  mergeRaw: (raw) => normalizeSmokeEmergencySnapshotRaw(raw),
  deriveUiStatus: deriveRunningAlarmUiStatus,
  useAllSettled: true,
  fallbackEquipmentKind: "detector",
  fallbackViewCategory: "smoke",
});
