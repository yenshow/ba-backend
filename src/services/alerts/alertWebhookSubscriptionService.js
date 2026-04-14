const db = require("../../database/db");

const normalizeId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function listByRuleId(ruleId) {
  const rid = normalizeId(ruleId);
  if (!rid) return [];
  const rows = await db.query(
    `SELECT * FROM alert_webhook_subscriptions WHERE rule_id = ? ORDER BY id DESC`,
    [rid],
  );
  return rows || [];
}

async function listByRuleIds(ruleIds) {
  const ids = Array.isArray(ruleIds)
    ? [...new Set(ruleIds.map(normalizeId).filter(Boolean))]
    : [];
  if (ids.length === 0) return [];
  const rows = await db.query(
    `SELECT * FROM alert_webhook_subscriptions WHERE rule_id = ANY(?) ORDER BY rule_id ASC, id DESC`,
    [ids],
  );
  return rows || [];
}

async function replaceForRule(ruleId, items = [], userId = null) {
  const rid = normalizeId(ruleId);
  if (!rid) throw new Error("rule_id 不合法");

  const list = Array.isArray(items) ? items : [];
  await db.transaction(async (tq) => {
    await tq(`DELETE FROM alert_webhook_subscriptions WHERE rule_id = ?`, [rid]);

    for (const it of list) {
      if (!it) continue;
      const enabled = it.enabled !== undefined ? Boolean(it.enabled) : true;
      const url = String(it.url || "").trim();
      if (!url) continue;
      const secret = it.secret != null && String(it.secret).trim() ? String(it.secret) : null;
      const headersJson =
        it.headers_json != null && typeof it.headers_json === "object" && !Array.isArray(it.headers_json)
          ? it.headers_json
          : null;

      await tq(
        `
        INSERT INTO alert_webhook_subscriptions (enabled, rule_id, url, secret, headers_json, created_by)
        VALUES (?, ?, ?, ?, ?::jsonb, ?)
        `,
        [
          enabled,
          rid,
          url,
          secret,
          headersJson ? JSON.stringify(headersJson) : null,
          userId != null ? Number(userId) : null,
        ],
      );
    }
  });

  return await listByRuleId(rid);
}

module.exports = {
  listByRuleId,
  listByRuleIds,
  replaceForRule,
};

