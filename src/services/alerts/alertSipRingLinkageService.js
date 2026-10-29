/**
 * 警報 SIP 室內語音廣播連動（門禁保全層 2）
 * device_ids 空＝全部室內機並行；有值＝指定室內機並行
 */
const db = require("../../database/db");
const { createLogger } = require("../../utils/logger");
const { alertIndoorDevice } = require("../accessSecurity/sipInviteService");
const operationalEventService = require("../operationalEvents/operationalEventService");
const {
  summaryIntercom,
  resolveBroadcastAction,
} = require("../operationalEvents/operationalEventCopy");
const licenseService = require("../license/licenseService");
const {
  normalizeIdList,
  createRuleLinkageCrud,
} = require("./alertLinkageHelpers");

/** 延遲載入，避免與 accessSecurityService 循環引用 */
const resolveLocationByIndoorDeviceId = (...args) =>
  require("../accessSecurity/accessSecurityService").resolveLocationByIndoorDeviceId(
    ...args,
  );

const logger = createLogger("alertSipRingLinkage");
const MAX_DEVICE_IDS = 100;

const crud = createRuleLinkageCrud({
  tableName: "alert_sip_ring_linkages",
  idsColumn: "device_ids",
  payloadIdsKey: "device_ids",
  maxIds: MAX_DEVICE_IDS,
});

const { getByRuleId, getByRuleIds, upsertForRule, deleteForRule } = crud;

const INDOOR_DEVICE_SELECT = `
  SELECT id, name, type_code, config
  FROM devices
  WHERE type_code = 'video_intercom'
    AND COALESCE(config->>'unitType', '') = 'indoor'
`;

async function loadIndoorRingTargets(selectedIds) {
  const list = normalizeIdList(selectedIds, MAX_DEVICE_IDS);
  if (list.length > 0) {
    const rows = await db.query(
      `${INDOOR_DEVICE_SELECT} AND id = ANY(?) ORDER BY id`,
      [list],
    );
    return rows || [];
  }
  const rows = await db.query(
    `${INDOOR_DEVICE_SELECT} ORDER BY id LIMIT ?`,
    [MAX_DEVICE_IDS],
  );
  return rows || [];
}

async function processSipRingLinkagesForNewAlert(alert) {
  const licensed = await licenseService.isRuntimeFeatureLicensed("access_security");
  if (!licensed) return;

  const rid = alert?.rule_id != null ? Number(alert.rule_id) : null;
  if (!Number.isInteger(rid) || rid <= 0) return;

  let linkage;
  try {
    linkage = await getByRuleId(rid);
  } catch (err) {
    logger.warn("查詢 SIP 語音廣播連動失敗", {
      ruleId: rid,
      error: err?.message || String(err),
    });
    return;
  }
  if (!linkage?.enabled) return;

  const selectedIds = Array.isArray(linkage.device_ids) ? linkage.device_ids : [];
  let devices = [];
  try {
    devices = await loadIndoorRingTargets(selectedIds);
  } catch (err) {
    logger.warn("載入語音廣播目標失敗", { error: err?.message || String(err) });
    return;
  }

  if (devices.length === 0) {
    logger.warn("SIP 語音廣播連動已啟用但無可用室內機", {
      ruleId: rid,
      alertId: alert?.id,
      selectedCount: selectedIds.length,
    });
    return;
  }

  const alertId = alert?.id ?? null;
  await Promise.allSettled(
    devices.map(async (device) => {
      try {
        const invite = await alertIndoorDevice(device, {
          source: "alert_linkage",
        });
        let indoorPlace = null;
        try {
          indoorPlace = await resolveLocationByIndoorDeviceId(device.id);
        } catch (lookupErr) {
          logger.warn("警報語音廣播對照戶別失敗", {
            deviceId: device.id,
            error: lookupErr?.message || String(lookupErr),
          });
        }
        const placeLabel =
          indoorPlace?.locationName || device.name || String(device.id);
        await operationalEventService.recordEvent({
          source: "alert_linkage",
          event_kind: "intercom",
          location_id: indoorPlace?.locationId ?? alert?.location_id ?? null,
          system_id: indoorPlace?.systemId ?? null,
          device_id: Number(device.id),
          message: summaryIntercom({
            placeLabel,
            action: resolveBroadcastAction(invite),
          }),
          payload: {
            layer: 2,
            fromAlertLinkage: true,
            alertId,
            ruleId: rid,
            invite,
          },
        });
      } catch (err) {
        logger.warn("SIP 語音廣播連動失敗", {
          deviceId: device.id,
          alertId,
          error: err?.message || String(err),
        });
      }
    }),
  );
}

module.exports = {
  MAX_DEVICE_IDS,
  getByRuleId,
  getByRuleIds,
  upsertForRule,
  deleteForRule,
  processSipRingLinkagesForNewAlert,
};
