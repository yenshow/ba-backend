const db = require("../../database/db");

const normalizeId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function getByRuleId(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return null;
  const rows = await db.query(
    `SELECT *
     FROM alert_email_subscriptions
     WHERE rule_id = ?
     LIMIT 1`,
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
    `SELECT *
     FROM alert_email_subscriptions
     WHERE rule_id = ANY(?)
     ORDER BY rule_id ASC`,
    [ids],
  );
  return rows || [];
}

async function upsertForRule(ruleId, payload, userId = null) {
  const rid = normalizeId(ruleId);
  if (!rid) throw new Error("rule_id 不合法");
  const p = payload || {};

  const enabled = p.enabled !== undefined ? Boolean(p.enabled) : false;
  const smtpHost = p.smtp_host != null ? String(p.smtp_host).trim() : null;
  const smtpPort =
    p.smtp_port != null && p.smtp_port !== ""
      ? Number(p.smtp_port)
      : null;
  const smtpUser = p.smtp_user != null ? String(p.smtp_user).trim() : null;
  const smtpPassword =
    p.smtp_password != null ? String(p.smtp_password) : null;
  const smtpSecurity = String(p.smtp_security || "none")
    .trim()
    .toLowerCase();

  const toEmails = Array.isArray(p.to_emails)
    ? p.to_emails.map((v) => String(v || "").trim()).filter(Boolean)
    : [];

  const repeatMinIntervalSeconds =
    p.repeat_min_interval_seconds != null
      ? Number(p.repeat_min_interval_seconds)
      : 15;
  const repeatMaxSendCount =
    p.repeat_max_send_count != null ? Number(p.repeat_max_send_count) : 10;

  await db.query(
    `
    INSERT INTO alert_email_subscriptions (
      enabled,
      rule_id,
      smtp_host,
      smtp_port,
      smtp_user,
      smtp_password,
      smtp_security,
      to_emails,
      repeat_min_interval_seconds,
      repeat_max_send_count,
      created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (rule_id)
    DO UPDATE SET
      enabled = EXCLUDED.enabled,
      smtp_host = EXCLUDED.smtp_host,
      smtp_port = EXCLUDED.smtp_port,
      smtp_user = EXCLUDED.smtp_user,
      smtp_password = EXCLUDED.smtp_password,
      smtp_security = EXCLUDED.smtp_security,
      to_emails = EXCLUDED.to_emails,
      repeat_min_interval_seconds = EXCLUDED.repeat_min_interval_seconds,
      repeat_max_send_count = EXCLUDED.repeat_max_send_count,
      created_by = EXCLUDED.created_by
    `,
    [
      enabled,
      rid,
      smtpHost,
      smtpPort != null && Number.isFinite(smtpPort) ? Math.trunc(smtpPort) : null,
      smtpUser,
      smtpPassword,
      smtpSecurity,
      toEmails,
      Number.isFinite(repeatMinIntervalSeconds)
        ? Math.trunc(repeatMinIntervalSeconds)
        : 15,
      Number.isFinite(repeatMaxSendCount) ? Math.trunc(repeatMaxSendCount) : 10,
      userId != null ? Number(userId) : null,
    ],
  );

  return await getByRuleId(rid);
}

async function deleteForRule(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return;
  await db.query(`DELETE FROM alert_email_subscriptions WHERE rule_id = ?`, [
    rid,
  ]);
}

module.exports = {
  getByRuleId,
  getByRuleIds,
  upsertForRule,
  deleteForRule,
};

