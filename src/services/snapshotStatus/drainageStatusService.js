/**
 * 衛生排水：依 location_systems 設定讀取 Modbus 並合成 uiStatus
 */
const alertService = require("../alerts/alertService");
const {
  mergeRuleSemanticsIntoDrainageFireSnapshotItems,
} = require("../alerts/systemAlertHelper");
const {
  mergeDrainageFirePumpSnapshotRaw,
  mergeDrainageFireTankSnapshotRaw,
} = require("../monitoring/systemSnapshotMonitorFactory");
const {
  resolveLocationSystemStatusFields,
  deriveSnapshotAggregateRunningUiStatus,
} = require("../monitoring/systemSnapshotStatusFields");
const {
  createModbusSnapshotStatusService,
} = require("./createModbusSnapshotStatusService");

const DRAINAGE_STATUS_FIELD_DEFAULTS = {
  equipmentKind: "pump",
  viewCategory: "drainage",
};

function resolveDrainageSystemFields(system) {
  return resolveLocationSystemStatusFields(
    system,
    DRAINAGE_STATUS_FIELD_DEFAULTS,
  );
}

module.exports = createModbusSnapshotStatusService({
  systemType: "drainage",
  loggerName: "drainageStatusService",
  alertSource: alertService.ALERT_SOURCES.DRAINAGE,
  alertSyncKey: "drainage",
  readErrorMessage: "無法讀取排水設備資料",
  resolveFields: resolveDrainageSystemFields,
  mergeRaw: (raw, fields) =>
    fields.equipmentKind === "tank"
      ? mergeDrainageFireTankSnapshotRaw(raw)
      : mergeDrainageFirePumpSnapshotRaw(raw),
  deriveUiStatus: deriveSnapshotAggregateRunningUiStatus,
  useRuleSemantics: true,
  mergeRuleSemantics: mergeRuleSemanticsIntoDrainageFireSnapshotItems,
});
