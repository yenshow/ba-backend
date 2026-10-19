/**
 * 警報門禁連動：新 active INSERT 時送 alwaysOpen。
 * device_ids 空＝全部已設定門禁；有值＝僅指定設備。不復歸；OE 由 controlRemoteDoor 寫入。
 */
const db = require("../../database/db");
const accessControlService = require("../accessControl/accessControlService");
const { createLogger } = require("../../utils/logger");
const licenseService = require("../license/licenseService");
const {
  createRuleLinkageCrud,
} = require("./alertLinkageHelpers");

const logger = createLogger("alertAccessDoorLinkage");
const ALWAYS_OPEN_CMD = "alwaysOpen";
const MAX_DEVICE_IDS = 100;

const crud = createRuleLinkageCrud({
  tableName: "alert_access_door_linkages",
  idsColumn: "device_ids",
  payloadIdsKey: "device_ids",
  maxIds: MAX_DEVICE_IDS,
});

const { getByRuleId, getByRuleIds, upsertForRule, deleteForRule } = crud;

async function listAccessDevices() {
  const rows = await db.query(
    `
    SELECT id, name, config
    FROM devices
    WHERE type_code = 'access_control'
    ORDER BY name ASC
    `,
  );
  return rows || [];
}

async function processAccessDoorLinkagesForNewAlert(alert) {
  const licensed = await licenseService.isRuntimeFeatureLicensed("people_counting");
  if (!licensed) return;

  const rid = alert?.rule_id != null ? Number(alert.rule_id) : null;
  if (!Number.isInteger(rid) || rid <= 0) return;

  let linkage;
  try {
    linkage = await getByRuleId(rid);
  } catch (err) {
    logger.warn("查詢門禁連動失敗", {
      ruleId: rid,
      error: err?.message || String(err),
    });
    return;
  }
  if (!linkage?.enabled) return;

  let devices = [];
  try {
    devices = await listAccessDevices();
  } catch (err) {
    logger.warn("載入門禁設備失敗", { error: err?.message || String(err) });
    return;
  }

  const selectedIds = Array.isArray(linkage.device_ids) ? linkage.device_ids : [];
  if (selectedIds.length > 0) {
    const allow = new Set(selectedIds);
    devices = devices.filter((d) => allow.has(Number(d.id)));
  }

  if (devices.length === 0) {
    logger.warn("門禁連動已啟用但無可用門禁設備", {
      ruleId: rid,
      alertId: alert?.id,
      selectedCount: selectedIds.length,
    });
    return;
  }

  const alertId = alert?.id ?? null;
  for (const device of devices) {
    try {
      await accessControlService.controlRemoteDoor(device.id, {
        cmd: ALWAYS_OPEN_CMD,
        operationalEvent: { fromAlertLinkage: true, alertId, ruleId: rid },
      });
    } catch (err) {
      logger.warn("門禁連動失敗", {
        deviceId: device.id,
        alertId,
        error: err?.message || String(err),
      });
    }
  }
}

module.exports = {
  MAX_DEVICE_IDS,
  getByRuleId,
  getByRuleIds,
  upsertForRule,
  deleteForRule,
  processAccessDoorLinkagesForNewAlert,
};
