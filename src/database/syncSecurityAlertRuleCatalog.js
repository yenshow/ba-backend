/**
 * 保全警報初版：依既有 security 地點的 status_points.running 補 bit_state DI 規則。
 * - 僅 INSERT 不存在者（source + target location + dimension_key）
 * - 不覆寫現場已改的規則
 * - 訊息模板用 canonical DI_V1（與警報設定新增預設相同）
 */
const {
  MESSAGE_TEMPLATE_KEYS,
  getCanonicalTemplateString,
} = require("../services/alerts/alertCopy");

function parseRunningBitAddress(statusPoints) {
  const running =
    statusPoints && typeof statusPoints === "object"
      ? statusPoints.running
      : null;
  if (!running || typeof running !== "object") return null;
  const address = Number(running.address);
  if (!Number.isFinite(address) || address < 0) return null;
  return address;
}

/** 相容 pg Pool 與專案 db.query（回傳 rows 陣列） */
async function runQuery(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  if (Array.isArray(result)) {
    return {
      rows: result,
      rowCount: typeof result.rowCount === "number" ? result.rowCount : result.length,
    };
  }
  return result;
}

/**
 * 為單一保全地點補 DI 初版規則（同事務 query 可用）。
 * @returns {'inserted'|'skipped'|'no_di'}
 */
async function ensureSecurityDiAlertRule(queryOrPool, locationId) {
  const id = Number(locationId);
  if (!Number.isFinite(id) || id <= 0) return "skipped";

  const locs = await runQuery(
    queryOrPool,
    `SELECT l.id AS location_id, l.name,
            ls.system_config->'status_points' AS status_points
     FROM location_systems ls
     JOIN locations l ON l.id = ls.location_id
     WHERE ls.system_type = 'security' AND l.id = $1
     LIMIT 1`,
    [id],
  );
  const row = (locs.rows || [])[0];
  if (!row) return "skipped";

  const address = parseRunningBitAddress(row.status_points);
  if (address == null) return "no_di";

  const bitKey = `di:${address}`;
  const dimensionKey = `di:ch:${address}`;
  const templateKey = MESSAGE_TEMPLATE_KEYS.DI_V1;
  const messageTemplate = getCanonicalTemplateString(templateKey);

  const exists = await runQuery(
    queryOrPool,
    `SELECT id FROM alert_rules
     WHERE source = 'security'
       AND alert_type = 'di'
       AND dimension_key = $1
       AND target_type = 'location'
       AND target_id = $2
     LIMIT 1`,
    [dimensionKey, id],
  );
  if ((exists.rowCount || 0) > 0) return "skipped";

  const inserted = await runQuery(
    queryOrPool,
    `INSERT INTO alert_rules (
       source, alert_type, severity, name, dimension_key,
       target_type, target_id, condition_type, condition_config,
       message_template_key, message_template_custom, message_template,
       enabled
     ) VALUES (
       'security', 'di', 'warning', $1, $2,
       'location', $3, 'bit_state', $4::jsonb,
       $5, FALSE, $6,
       TRUE
     )`,
    [
      row.name ? `保全 DI：${row.name}` : "保全 DI 活動",
      dimensionKey,
      id,
      JSON.stringify({ bit_key: bitKey }),
      templateKey,
      messageTemplate,
    ],
  );
  return (inserted.rowCount || 0) > 0 ? "inserted" : "skipped";
}

async function syncSecurityAlertRuleCatalog(pool) {
  const locs = await runQuery(
    pool,
    `SELECT ls.id AS system_id, l.id AS location_id, l.name,
            ls.system_config->'status_points' AS status_points
     FROM location_systems ls
     JOIN locations l ON l.id = ls.location_id
     WHERE ls.system_type = 'security'`,
  );

  let insertedCount = 0;
  let skippedCount = 0;
  const rows = locs.rows || [];

  for (const row of rows) {
    const result = await ensureSecurityDiAlertRule(pool, row.location_id);
    if (result === "inserted") insertedCount += 1;
    else skippedCount += 1;
  }

  return {
    locationCount: rows.length,
    insertedCount,
    skippedCount,
  };
}

module.exports = {
  ensureSecurityDiAlertRule,
  syncSecurityAlertRuleCatalog,
};
