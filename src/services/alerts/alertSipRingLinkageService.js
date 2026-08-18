/**
 * 警報 SIP 室內語音廣播連動（門禁保全層 2）
 * device_ids 空＝全部室內機並行；有值＝指定室內機並行
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { createLogger } = require("../../utils/logger");
const { alertIndoorDevice } = require("../accessSecurity/sipInviteService");
const operationalEventService = require("../operationalEvents/operationalEventService");
const licenseService = require("../license/licenseService");

/** 延遲載入，避免與 accessSecurityService 循環引用 */
const resolveLocationByIndoorDeviceId = (...args) =>
  require("../accessSecurity/accessSecurityService").resolveLocationByIndoorDeviceId(...args);

const logger = createLogger("alertSipRingLinkage");
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
    `SELECT * FROM alert_sip_ring_linkages WHERE rule_id = ? LIMIT 1`,
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
    `SELECT * FROM alert_sip_ring_linkages WHERE rule_id = ANY(?)`,
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
    INSERT INTO alert_sip_ring_linkages (rule_id, enabled, device_ids, created_by)
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
    `DELETE FROM alert_sip_ring_linkages WHERE rule_id = ? RETURNING id`,
    [rid],
  );
  return { deleted: rows?.length || 0 };
}

const INDOOR_DEVICE_SELECT = `
  SELECT id, name, type_code, config
  FROM devices
  WHERE type_code = 'video_intercom'
    AND COALESCE(config->>'unitType', '') = 'indoor'
`;

async function loadIndoorRingTargets(selectedIds) {
  const list = normalizeIdList(selectedIds);
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
        const actionLabel = invite.played ? "警報語音廣播" : "警報振鈴";
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
          indoorPlace?.locationName || device.name || device.id;
        await operationalEventService.recordEvent({
          source: "alert_linkage",
          event_kind: "intercom",
          location_id: indoorPlace?.locationId ?? alert?.location_id ?? null,
          system_id: indoorPlace?.systemId ?? null,
          device_id: Number(device.id),
          summary: invite.ok
            ? `${actionLabel} ${placeLabel}`
            : `${actionLabel}失敗 ${placeLabel}`,
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
