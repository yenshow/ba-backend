/**
 * 空氣循環：依 location_systems 設定讀取 Modbus 並合成 uiStatus
 */
const alertService = require("../alerts/alertService");
const {
  mergeAirCirculationSnapshotRaw,
} = require("../monitoring/systemSnapshotMonitorFactory");
const {
  deriveRunningAlarmUiStatus,
} = require("./modbusSnapshotHelpers");
const {
  createModbusSnapshotStatusService,
} = require("./createModbusSnapshotStatusService");

function resolveAirCirculationFields(system) {
  const cfg = system.config || {};
  // SSOT：以 statusPoints.running 為主（與 smoke_alarm / emergency_rescue 對齊）
  const statusPoints =
    cfg?.statusPoints && typeof cfg.statusPoints === "object"
      ? cfg.statusPoints
      : {};
  return {
    deviceId: cfg.deviceId,
    modbus: cfg.modbus,
    equipmentKind: cfg.equipmentKind || "pump",
    viewCategory: cfg.viewCategory || "air_circulation",
    statusPoints,
  };
}

module.exports = createModbusSnapshotStatusService({
  systemType: "air_circulation",
  loggerName: "airCirculationStatusService",
  alertSource: alertService.ALERT_SOURCES.AIR_CIRCULATION,
  alertSyncKey: "air_circulation",
  readErrorMessage: "無法讀取空氣循環設備資料",
  resolveFields: resolveAirCirculationFields,
  mergeRaw: (raw) => mergeAirCirculationSnapshotRaw(raw),
  deriveUiStatus: deriveRunningAlarmUiStatus,
  useAllSettled: true,
  fallbackEquipmentKind: "pump",
  fallbackViewCategory: "air_circulation",
});