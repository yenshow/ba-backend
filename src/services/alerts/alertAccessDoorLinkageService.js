/**
 * 警報門禁連動：新 active INSERT 時送 alwaysOpen。
 * device_ids 空＝全部已設定門禁；有值＝僅指定設備。不復歸；OE 由 controlRemoteDoor 寫入。
 */
const db = require("../../database/db");
const accessControlService = require("../accessControl/accessControlService");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { createLogger } = require("../../utils/logger");
const licenseService = require("../license/licenseService");

const logger = createLogger("alertAccessDoorLinkage");
const ALWAYS_OPEN_CMD = "alwaysOpen";
const MAX_DEVICE_IDS = 100;

const normalizeId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const normalizeIdList = (v, maxLen = MAX_DEVICE_IDS) => {
  if (!Array.isArray(v)) return [];
  const ids = v.map(normalizeId).filter(Boolean);
  return [...new Set(ids)].slice(0, maxLen);
};

const parsePgIntArray = (v) => {
  if (Array.isArray(v)) return normalizeIdList(v);
  if (typeof v !== "string") return [];
  const inner = v.trim().replace(/^\s*\{|\}\s*$/g, "");
  if (!inner) return [];
  return normalizeIdList(inner.split(","));
};

const normalizeRow = (row) => {
  if (!row) return row;
  return {
    ...row,
    device_ids: parsePgIntArray(row.device_ids),
  };
};

async function getByRuleId(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return null;
  const rows = await db.query(
    `SELECT * FROM alert_access_door_linkages WHERE rule_id = ? LIMIT 1`,
    [rid],
  );
  return normalizeRow(rows?.[0] || null);
}

async function getByRuleIds(ruleIds) {
  const ids = Array.isArray(ruleIds)
    ? [...new Set(ruleIds.map(normalizeId).filter(Boolean))]
    : [];
  if (ids.length === 0) return [];
  const rows = await db.query(
    `SELECT * FROM alert_access_door_linkages WHERE rule_id = ANY(?)`,
    [ids],
  );
  return (rows || []).map(normalizeRow);
}

async function upsertForRule(ruleId, payload, userId = null) {
  const rid = normalizeId(ruleId);
  if (!rid) throwApiError(C.ALERT_LINKAGE_RULE_ID_INVALID, "rule_id 不合法");
  const enabled = payload?.enabled !== undefined ? Boolean(payload.enabled) : true;
  const deviceIds = normalizeIdList(payload?.device_ids, MAX_DEVICE_IDS);

  const rows = await db.query(
    `
    INSERT INTO alert_access_door_linkages (rule_id, enabled, device_ids, created_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (rule_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      device_ids = EXCLUDED.device_ids,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [rid, enabled, deviceIds, userId != null ? Number(userId) : null],
  );
  return normalizeRow(rows?.[0] || null);
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
