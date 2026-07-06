const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const normalizeId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const normalizeIdList = (v, maxLen = 4) => {
  if (!Array.isArray(v)) return [];
  const ids = v.map(normalizeId).filter(Boolean);
  return [...new Set(ids)].slice(0, maxLen);
};

const parsePgIntArray = (v) => {
  if (Array.isArray(v)) {
    return v
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 4);
  }
  if (typeof v !== "string") return [];
  const s = v.trim();
  if (!s) return [];
  // 支援 "{1,2,3}" 或 "1,2,3"
  const inner = s.replace(/^\s*\{|\}\s*$/g, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 4);
};

const normalizeRow = (row) => {
  if (!row) return row;
  const out = {
    ...row,
    camera_device_ids: parsePgIntArray(row.camera_device_ids),
  };
  delete out.camera_device_id;
  return out;
};

async function getByRuleId(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return null;
  const rows = await db.query(
    `SELECT * FROM alert_camera_linkages WHERE rule_id = ? LIMIT 1`,
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
    `SELECT * FROM alert_camera_linkages WHERE rule_id = ANY(?)`,
    [ids],
  );
  return (rows || []).map(normalizeRow);
}

async function upsertForRule(ruleId, payload, userId = null) {
  const rid = normalizeId(ruleId);
  if (!rid) throwApiError(C.ALERT_LINKAGE_RULE_ID_INVALID, "rule_id 不合法");
  const enabled = payload?.enabled !== undefined ? Boolean(payload.enabled) : true;
  const cameraDeviceIds = normalizeIdList(payload?.camera_device_ids, 4);

  const rows = await db.query(
    `
    INSERT INTO alert_camera_linkages (rule_id, enabled, camera_device_ids, created_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (rule_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      camera_device_ids = EXCLUDED.camera_device_ids,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [rid, enabled, cameraDeviceIds, userId != null ? Number(userId) : null],
  );
  return normalizeRow(rows?.[0] || null);
}

async function deleteForRule(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return { deleted: 0 };
  const rows = await db.query(
    `DELETE FROM alert_camera_linkages WHERE rule_id = ? RETURNING id`,
    [rid],
  );
  return { deleted: rows?.length || 0 };
}

module.exports = {
  getByRuleId,
  getByRuleIds,
  upsertForRule,
  deleteForRule,
};

