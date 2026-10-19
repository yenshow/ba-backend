/**
 * 消防系統：依 location_systems 設定讀取 Modbus 並合成 uiStatus
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

const FIRE_STATUS_FIELD_DEFAULTS = {
  equipmentKind: "pump",
  viewCategory: "sprinkler",
};

function resolveFireSystemFields(system) {
  return resolveLocationSystemStatusFields(system, FIRE_STATUS_FIELD_DEFAULTS);
}

module.exports = createModbusSnapshotStatusService({
  systemType: "fire",
  loggerName: "fireStatusService",
  alertSource: alertService.ALERT_SOURCES.FIRE,
  alertSyncKey: "fire",
  readErrorMessage: "無法讀取消防設備資料",
  resolveFields: resolveFireSystemFields,
  mergeRaw: (raw, fields) =>
    fields.equipmentKind === "tank"
      ? mergeDrainageFireTankSnapshotRaw(raw)
      : mergeDrainageFirePumpSnapshotRaw(raw),
  deriveUiStatus: deriveSnapshotAggregateRunningUiStatus,
  useRuleSemantics: true,
  mergeRuleSemantics: mergeRuleSemanticsIntoDrainageFireSnapshotItems,
});
