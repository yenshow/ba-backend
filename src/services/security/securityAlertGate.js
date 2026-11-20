/**
 * 保全時間排程／佈防閘門（DI／門禁共用）
 * - DI 活動警報：由「警報設定」bit_state 規則觸發，此閘門決定是否升級為 alerts
 * - 門禁／讀卡：排程外直接建 alert（無 bit 規則）
 * - 排程內（或無綁定啟用規則）→ 不建活動類 alert，並可結案殘留
 * - 地點佈防模式：twenty_four_hour／immediate／delay
 */
const db = require("../../database/db");
const alertService = require("../alerts/alertService");
const securityScheduleService = require("./securityScheduleService");
const securityArmingDelayService = require("./securityArmingDelayService");
const { createLogger } = require("../../utils/logger");

const logger = createLogger("securityAlertGate");

const ALCOHOL_SUB_TYPES = new Set([2077, 2078, 2079]);
/** 連線／系統錯誤類：進入排程時不自動結案 */
const CONNECTIVITY_ALERT_TYPES = new Set(["offline", "error"]);

/**
 * 評估地點是否視為「撤防／活動」（不建警報）
 * @returns {Promise<{ disarmed: boolean, arming: object|null, schedulePermitted: boolean, inExitGrace: boolean }>}
 */
async function evaluateDisarmedState(systemId, at = new Date()) {
  const arming =
    await securityScheduleService.getArmingConfigBySystemId(systemId);

  if (!arming) {
    return {
      disarmed: true,
      arming: null,
      schedulePermitted: true,
      inExitGrace: false,
    };
  }

  if (arming.armingMode === "twenty_four_hour") {
    return {
      disarmed: false,
      arming,
      schedulePermitted: false,
      inExitGrace: false,
    };
  }

  const schedulePermitted = await securityScheduleService.isPermittedNow(
    arming.locationId,
    at,
  );
  securityArmingDelayService.syncExitGrace(
    arming.locationId,
    schedulePermitted,
    arming,
  );
  const inExitGrace =
    !schedulePermitted &&
    arming.armingMode === "delay" &&
    securityArmingDelayService.isInExitGrace(arming.locationId);

  return {
    disarmed: schedulePermitted || inExitGrace,
    arming,
    schedulePermitted,
    inExitGrace,
  };
}

async function createAlertNow({
  systemId,
  alertType,
  dimensionKey,
  message,
  severity,
  ruleId,
}) {
  return alertService.createAlert({
    source: alertService.ALERT_SOURCES.SECURITY,
    source_id: Number(systemId),
    alert_type: alertType,
    dimension_key: dimensionKey,
    severity,
    message,
    rule_id: ruleId != null ? Number(ruleId) : null,
  });
}

async function createOutsideScheduleAlert({
  systemId,
  alertType,
  dimensionKey,
  message,
  severity = alertService.SEVERITIES.WARNING,
  ruleId = null,
  at = null,
}) {
  const sid = Number(systemId);
  if (!Number.isFinite(sid) || sid <= 0) return null;

  const when = at ? new Date(at) : new Date();
  const { disarmed, arming } = await evaluateDisarmedState(sid, when);
  if (disarmed) {
    securityArmingDelayService.cancelEntryDelay(sid, alertType, dimensionKey);
    await resolveSecurityActivityAlerts(sid);
    return null;
  }

  if (arming?.armingMode === "delay") {
    const result = securityArmingDelayService.startOrContinueEntryDelay({
      systemId: sid,
      alertType,
      dimensionKey,
      entryDelaySec: arming.entryDelaySec,
      onFire: () =>
        createAlertNow({
          systemId: sid,
          alertType,
          dimensionKey,
          message,
          severity,
          ruleId,
        }),
    });
    if (result === "pending") return null;
  }

  return createAlertNow({
    systemId: sid,
    alertType,
    dimensionKey,
    message,
    severity,
    ruleId,
  });
}

/**
 * DI 恢復（bit false）：取消進入延遲並結案
 */
async function cancelPendingSecurityAlert({
  systemId,
  alertType,
  dimensionKey,
}) {
  const sid = Number(systemId);
  if (!Number.isFinite(sid) || sid <= 0) return;
  securityArmingDelayService.cancelEntryDelay(sid, alertType, dimensionKey);
  try {
    await alertService.resolveAlert(
      sid,
      alertType,
      alertService.ALERT_SOURCES.SECURITY,
      dimensionKey ?? null,
    );
  } catch (err) {
    if (!String(err?.message || "").includes("未找到可更新的警報")) {
      logger.warn("結案保全警報失敗", {
        error: err?.message || String(err),
        systemId: sid,
        alertType,
      });
    }
  }
}

/**
 * 結案該 system 的活動類 active alerts（保留 offline／error）
 */
async function resolveSecurityActivityAlerts(systemId) {
  const sid = Number(systemId);
  if (!Number.isFinite(sid) || sid <= 0) return 0;

  securityArmingDelayService.cancelAllEntryDelaysForSystem(sid);

  let rows = [];
  try {
    rows = await db.query(
      `SELECT alert_type, dimension_key
       FROM alerts
       WHERE source = ?
         AND source_id = ?
         AND status = 'active'
         AND alert_type IS NOT NULL`,
      [alertService.ALERT_SOURCES.SECURITY, sid],
    );
  } catch (err) {
    logger.warn("查詢保全活動警報失敗", {
      error: err?.message || String(err),
      systemId: sid,
    });
    return 0;
  }

  let resolved = 0;
  for (const row of rows || []) {
    const alertType = String(row.alert_type || "").trim();
    if (!alertType || CONNECTIVITY_ALERT_TYPES.has(alertType)) continue;
    try {
      await alertService.resolveAlert(
        sid,
        alertType,
        alertService.ALERT_SOURCES.SECURITY,
        row.dimension_key ?? null,
      );
      resolved += 1;
    } catch (err) {
      if (!String(err?.message || "").includes("未找到可更新的警報")) {
        logger.warn("結案保全活動警報失敗", {
          error: err?.message || String(err),
          systemId: sid,
          alertType,
        });
      }
    }
  }
  return resolved;
}

/** 撤防／許可時才結案；disarmed===false 時不動作 */
async function resolveActivityAlertsIfPermitted(systemId, permitted = null) {
  const sid = Number(systemId);
  if (!Number.isFinite(sid) || sid <= 0) return 0;

  let disarmed;
  if (permitted == null) {
    const state = await evaluateDisarmedState(sid);
    disarmed = state.disarmed;
  } else {
    disarmed = Boolean(permitted);
  }
  if (!disarmed) return 0;
  return resolveSecurityActivityAlerts(sid);
}

/**
 * 門禁／讀卡事件：佈防中建 alert
 */
async function maybeAlertAccessEvent({ deviceId, eventTime, payload }) {
  const did = Number(deviceId);
  if (!Number.isFinite(did) || did <= 0) return;
  const sub = Number(payload?.subEventType ?? payload?.minor);
  if (ALCOHOL_SUB_TYPES.has(sub)) return;

  const locations =
    await securityScheduleService.listSecurityLocationsByAccessDeviceId(did);
  if (!locations.length) return;

  const at = eventTime ? new Date(eventTime) : new Date();
  for (const loc of locations) {
    try {
      await createOutsideScheduleAlert({
        systemId: loc.systemId,
        alertType: "di",
        dimensionKey: `access:device:${did}`,
        message: `保全時間排程外活動：${loc.locationName || "地點"}（門禁／讀卡設備 #${did}）`,
        severity: alertService.SEVERITIES.WARNING,
        at,
      });
    } catch (err) {
      logger.warn("保全門禁時段告警失敗", {
        error: err?.message || String(err),
        deviceId: did,
        systemId: loc.systemId,
      });
    }
  }
}

module.exports = {
  createOutsideScheduleAlert,
  cancelPendingSecurityAlert,
  resolveSecurityActivityAlerts,
  resolveActivityAlertsIfPermitted,
  maybeAlertAccessEvent,
  evaluateDisarmedState,
};
