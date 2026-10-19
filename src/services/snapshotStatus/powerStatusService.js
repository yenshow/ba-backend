/**
 * 電力系統：依 location_systems 讀取 Modbus 並合成 uiStatus（發電機／ATS）
 */
const alertService = require("../alerts/alertService");
const {
  mergeRuleSemanticsIntoPowerSnapshotItems,
} = require("../alerts/systemAlertHelper");
const {
  mergePowerAtsSnapshotRaw,
  mergePowerGeneratorSnapshotRaw,
  mergePowerOilLevelSnapshotRaw,
} = require("../monitoring/systemSnapshotMonitorFactory");
const {
  resolveLocationSystemStatusFields,
  deriveSnapshotAggregateRunningUiStatus,
} = require("../monitoring/systemSnapshotStatusFields");
const {
  createModbusSnapshotStatusService,
} = require("./createModbusSnapshotStatusService");

const POWER_STATUS_FIELD_DEFAULTS = {
  equipmentKind: "generator",
  viewCategory: "generator",
};

function resolvePowerSystemFields(system) {
  return resolveLocationSystemStatusFields(system, POWER_STATUS_FIELD_DEFAULTS);
}

function mergePowerRaw(raw, fields) {
  if (fields.equipmentKind === "ats") {
    return mergePowerAtsSnapshotRaw(raw);
  }
  if (fields.equipmentKind === "oil_level") {
    return mergePowerOilLevelSnapshotRaw(raw);
  }
  return mergePowerGeneratorSnapshotRaw(raw);
}

module.exports = createModbusSnapshotStatusService({
  systemType: "power",
  loggerName: "powerStatusService",
  alertSource: alertService.ALERT_SOURCES.POWER,
  alertSyncKey: "power",
  readErrorMessage: "無法讀取電力設備資料",
  resolveFields: resolvePowerSystemFields,
  mergeRaw: mergePowerRaw,
  deriveUiStatus: deriveSnapshotAggregateRunningUiStatus,
  useRuleSemantics: true,
  mergeRuleSemantics: mergeRuleSemanticsIntoPowerSnapshotItems,
});
