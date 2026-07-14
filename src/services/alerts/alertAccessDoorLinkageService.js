/**
 * 警報門禁全開：新 active INSERT 時對全部門禁送 alwaysOpen（不復歸；OE 由 controlRemoteDoor 寫入）。
 */
const db = require("../../database/db");
const { parseConfig } = require("../../utils/deviceHelpers");
const accessControlService = require("../accessControl/accessControlService");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { createLogger } = require("../../utils/logger");

const logger = createLogger("alertAccessDoorLinkage");
const ALWAYS_OPEN_CMD = "alwaysOpen";

const normalizeId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function getByRuleId(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return null;
  const rows = await db.query(
    `SELECT * FROM alert_access_door_linkages WHERE rule_id = ? LIMIT 1`,
    [rid],
  );
  return rows?.[0] || null;
}

async function getByRuleIds(ruleIds) {
  const ids = Array.isArray(ruleIds)
    ? [...new Set(ruleIds.map(normalizeId).filter(Boolean))]
    : [];
  if (ids.length === 0) return [];
  return db.query(
    `SELECT * FROM alert_access_door_linkages WHERE rule_id = ANY(?)`,
    [ids],
  );
}

async function upsertForRule(ruleId, payload, userId = null) {
  const rid = normalizeId(ruleId);
  if (!rid) throwApiError(C.ALERT_LINKAGE_RULE_ID_INVALID, "rule_id 不合法");
  const enabled = payload?.enabled !== undefined ? Boolean(payload.enabled) : true;
  const rows = await db.query(
    `
    INSERT INTO alert_access_door_linkages (rule_id, enabled, created_by)
    VALUES (?, ?, ?)
    ON CONFLICT (rule_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [rid, enabled, userId != null ? Number(userId) : null],
  );
  return rows?.[0] || null;
}

async function deleteForRule(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return { deleted: 0 };
  const rows = await db.query(
    `DELETE FROM alert_access_door_linkages WHERE rule_id = ? RETURNING id`,
    [rid],
  );
  return { deleted: rows?.length || 0 };
}

async function listConfiguredAccessDevices() {
  const rows = await db.query(
    `
    SELECT id, name, config
    FROM devices
    WHERE type_code = 'access_control'
    ORDER BY name ASC
    `,
  );
  return (rows || [])
    .map((row) => ({ ...row, config: parseConfig(row.config) }))
    .filter((d) => d.config?.host && d.config?.username && d.config?.password);
}

async function processAccessDoorLinkagesForNewAlert(alert) {
  const rid = alert?.rule_id != null ? Number(alert.rule_id) : null;
  if (!Number.isInteger(rid) || rid <= 0) return;

  let linkage;
  try {
    linkage = await getByRuleId(rid);
  } catch (err) {
    logger.warn("查詢門禁全開連動失敗", {
      ruleId: rid,
      error: err?.message || String(err),
    });
    return;
  }
  if (!linkage?.enabled) return;

  let devices = [];
  try {
    devices = await listConfiguredAccessDevices();
  } catch (err) {
    logger.warn("載入門禁設備失敗", { error: err?.message || String(err) });
    return;
  }
  if (devices.length === 0) {
    logger.warn("門禁全開已啟用但無可用門禁設備", { ruleId: rid, alertId: alert?.id });
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
      logger.warn("門禁全開連動失敗", {
        deviceId: device.id,
        alertId,
        error: err?.message || String(err),
      });
    }
  }
}

module.exports = {
  getByRuleId,
  getByRuleIds,
  upsertForRule,
  deleteForRule,
  processAccessDoorLinkagesForNewAlert,
};
