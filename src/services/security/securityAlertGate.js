/**
 * 保全時間排程閘門（DI／門禁共用）
 * - DI 活動警報：由「警報設定」bit_state 規則觸發，此閘門決定是否升級為 alerts
 * - 門禁／讀卡：排程外直接建 alert（無 bit 規則）
 * - 排程內（或無啟用規則）→ 不建活動類 alert，並可結案殘留
 */
const db = require("../../database/db");
const alertService = require("../alerts/alertService");
const securityScheduleService = require("./securityScheduleService");
const { createLogger } = require("../../utils/logger");

const logger = createLogger("securityAlertGate");

const ALCOHOL_SUB_TYPES = new Set([2077, 2078, 2079]);
/** 連線／系統錯誤類：進入排程時不自動結案 */
const CONNECTIVITY_ALERT_TYPES = new Set(["offline", "error"]);

async function createOutsideScheduleAlert({
  systemId,
  alertType,
  dimensionKey,
  message,
  severity = alertService.SEVERITIES.WARNING,
  ruleId = null,
}) {
  const sid = Number(systemId);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  const permitted = await securityScheduleService.isPermittedNowBySystemId(sid);
  if (permitted) {
    await resolveSecurityActivityAlerts(sid);
    return null;
  }
  return alertService.createAlert({
    source: alertService.ALERT_SOURCES.SECURITY,
    source_id: sid,
    alert_type: alertType,
    dimension_key: dimensionKey,
    severity,
    message,
    rule_id: ruleId != null ? Number(ruleId) : null,
  });
}

/**
 * 結案該 system 的活動類 active alerts（保留 offline／error）
 */
async function resolveSecurityActivityAlerts(systemId) {
  const sid = Number(systemId);
  if (!Number.isFinite(sid) || sid <= 0) return 0;

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

/** 排程內才結案；permitted===false 時不動作 */
async function resolveActivityAlertsIfPermitted(systemId, permitted = null) {
  const sid = Number(systemId);
  if (!Number.isFinite(sid) || sid <= 0) return 0;
  const isPermitted =
    permitted == null
      ? await securityScheduleService.isPermittedNowBySystemId(sid)
      : Boolean(permitted);
  if (!isPermitted) return 0;
  return resolveSecurityActivityAlerts(sid);
}

/**
 * 門禁／讀卡事件：時段外建 alert
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
      const permitted = await securityScheduleService.isPermittedNow(
        loc.locationId,
        at,
      );
      if (permitted) {
        await resolveSecurityActivityAlerts(loc.systemId);
        continue;
      }
      await alertService.createAlert({
        source: alertService.ALERT_SOURCES.SECURITY,
        source_id: loc.systemId,
        alert_type: "di",
        dimension_key: `access:device:${did}`,
        severity: alertService.SEVERITIES.WARNING,
        message: `保全時間排程外活動：${loc.locationName || "地點"}（門禁／讀卡設備 #${did}）`,
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
  resolveSecurityActivityAlerts,
  resolveActivityAlertsIfPermitted,
  maybeAlertAccessEvent,
};
