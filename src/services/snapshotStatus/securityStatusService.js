/**
 * 保全：Modbus DI 快照（門禁設備狀態不進本快照，僅平面圖 DI）
 * - 排程內 running → uiStatus=activity（顯示用；alerts 仍靠警報設定 bit_state＋閘門）
 * - 排程外 running → uiStatus=alarm
 */
const alertService = require("../alerts/alertService");
const securityScheduleService = require("../security/securityScheduleService");
const {
  resolveActivityAlertsIfPermitted,
} = require("../security/securityAlertGate");
const {
  normalizeSmokeEmergencySnapshotRaw,
} = require("../monitoring/systemSnapshotMonitorFactory");
const {
  deriveRunningAlarmUiStatus,
} = require("./modbusSnapshotHelpers");
const {
  createModbusSnapshotStatusService,
} = require("./createModbusSnapshotStatusService");
const logger = require("../../utils/logger");

const statusLogger = logger.createLogger("securityStatusService");

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

async function afterBuildSecurityItems(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const it of list) {
    const sid = Number(it?.systemId);
    let schedulePermitted = true;
    if (Number.isFinite(sid) && sid > 0) {
      try {
        schedulePermitted =
          await securityScheduleService.isPermittedNowBySystemId(sid);
        // 進入排程：結案規則／門禁留下的活動類 alert（不新建；新建靠警報設定）
        await resolveActivityAlertsIfPermitted(sid, schedulePermitted);
      } catch (err) {
        statusLogger.warn("保全排程語意套用失敗（略過）", {
          systemId: sid,
          error: err?.message || String(err),
          module: "securityStatusService",
        });
      }
    }

    const rawBase = it?.raw && typeof it.raw === "object" ? it.raw : {};
    const uiStatus =
      schedulePermitted && it?.uiStatus === "alarm" ? "activity" : it?.uiStatus;

    out.push({
      ...it,
      uiStatus,
      raw: { ...rawBase, schedulePermitted },
    });
  }
  return out;
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
  afterBuildItems: afterBuildSecurityItems,
});
