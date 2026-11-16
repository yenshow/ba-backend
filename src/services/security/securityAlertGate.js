/**
 * 保全時段外告警閘門（DI／門禁共用）
 */
const alertService = require("../alerts/alertService");
const securityScheduleService = require("./securityScheduleService");
const { createLogger } = require("../../utils/logger");

const logger = createLogger("securityAlertGate");

const ALCOHOL_SUB_TYPES = new Set([2077, 2078, 2079]);

async function createOutsideScheduleAlert({
  systemId,
  alertType,
  dimensionKey,
  message,
  severity = alertService.SEVERITIES.WARNING,
}) {
  const sid = Number(systemId);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  const permitted = await securityScheduleService.isPermittedNowBySystemId(sid);
  if (permitted) return null;
  return alertService.createAlert({
    source: alertService.ALERT_SOURCES.SECURITY,
    source_id: sid,
    alert_type: alertType,
    dimension_key: dimensionKey,
    severity,
    message,
  });
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
      if (permitted) continue;
      await alertService.createAlert({
        source: alertService.ALERT_SOURCES.SECURITY,
        source_id: loc.systemId,
        alert_type: "di",
        dimension_key: `access:device:${did}`,
        severity: alertService.SEVERITIES.WARNING,
        message: `保全時段外活動：${loc.locationName || "地點"}（門禁／讀卡設備 #${did}）`,
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
  maybeAlertAccessEvent,
};
