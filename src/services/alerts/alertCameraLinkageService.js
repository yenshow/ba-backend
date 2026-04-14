const db = require("../../database/db");

const normalizeId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function getByRuleId(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return null;
  const rows = await db.query(
    `SELECT * FROM alert_camera_linkages WHERE rule_id = ? LIMIT 1`,
    [rid],
  );
  return rows?.[0] || null;
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
  return rows || [];
}

async function upsertForRule(ruleId, payload, userId = null) {
  const rid = normalizeId(ruleId);
  if (!rid) throw new Error("rule_id 不合法");
  const enabled = payload?.enabled !== undefined ? Boolean(payload.enabled) : true;
  const cameraDeviceId = normalizeId(payload?.camera_device_id);

  const rows = await db.query(
    `
    INSERT INTO alert_camera_linkages (rule_id, enabled, camera_device_id, created_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (rule_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      camera_device_id = EXCLUDED.camera_device_id,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [rid, enabled, cameraDeviceId, userId != null ? Number(userId) : null],
  );
  return rows?.[0] || null;
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

