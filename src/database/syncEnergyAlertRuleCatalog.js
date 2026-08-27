const { listEnergyAlertRules } = require("../constants/energyAlertRuleCatalog");
const {
  getCanonicalTemplateString,
} = require("../services/alerts/alertCopy");

const INSERT_ENERGY_RULE_SQL = `
  INSERT INTO alert_rules (
    source,
    alert_type,
    severity,
    name,
    dimension_key,
    target_type,
    target_id,
    condition_type,
    condition_config,
    message_template_key,
    message_template_custom,
    message_template,
    enabled
  )
  VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7::jsonb, $8, FALSE, $9, $10)
`;

async function insertEnergyAlertRule(pool, rule) {
  const messageTemplate = getCanonicalTemplateString(rule.message_template_key);
  return pool.query(INSERT_ENERGY_RULE_SQL, [
    rule.source,
    rule.alert_type,
    rule.severity,
    rule.name,
    rule.dimension_key,
    rule.condition_type,
    JSON.stringify(rule.condition_config || {}),
    rule.message_template_key,
    messageTemplate,
    rule.enabled !== false,
  ]);
}

/**
 * 僅補入 catalog 中不存在的能源規則（以 source + dimension_key 判斷）。
 * 現場可能已調整，因此禁止 UPDATE 覆寫既有列。
 */
async function syncEnergyAlertRuleCatalog(pool) {
  const catalog = listEnergyAlertRules();
  let insertedCount = 0;

  for (const rule of catalog) {
    const exists = await pool.query(
      `
        SELECT id FROM alert_rules
        WHERE source = $1 AND dimension_key = $2
        LIMIT 1
      `,
      [rule.source, rule.dimension_key],
    );
    if (exists.rowCount > 0) continue;

    const result = await insertEnergyAlertRule(pool, rule);
    insertedCount += result.rowCount;
  }

  return { catalogCount: catalog.length, insertedCount };
}

function applyLegacySettingsToCatalog(config, catalog) {
  const byDim = new Map(catalog.map((r) => [r.dimension_key, { ...r }]));
  const stages = Array.isArray(config.load_shed_stages) ? config.load_shed_stages : [];

  for (const stage of stages) {
    const level = Number(stage?.level);
    if (level < 1 || level > 3) continue;
    const entry = byDim.get(`contract_stage_${level}`);
    if (!entry) continue;
    entry.enabled = stage.enabled !== false;
    if (stage.threshold_pct != null) {
      entry.condition_config = {
        ...entry.condition_config,
        level,
        threshold_pct:
          Number(stage.threshold_pct) || entry.condition_config.threshold_pct,
      };
    }
  }

  if (config.meter_stale_enabled === false) {
    const entry = byDim.get("meter_stale");
    if (entry) entry.enabled = false;
  }
  if (config.meter_stale_minutes != null) {
    const entry = byDim.get("meter_stale");
    if (entry) {
      entry.condition_config = {
        ...entry.condition_config,
        stale_minutes: Number(config.meter_stale_minutes) || 15,
      };
    }
  }

  if (config.reading_jump_enabled === false) {
    const entry = byDim.get("reading_jump");
    if (entry) entry.enabled = false;
  }
  if (
    config.reading_jump_multiplier != null ||
    config.reading_jump_min_kwh != null
  ) {
    const entry = byDim.get("reading_jump");
    if (entry) {
      entry.condition_config = {
        multiplier:
          Number(config.reading_jump_multiplier) ||
          entry.condition_config.multiplier,
        min_kwh:
          Number(config.reading_jump_min_kwh) || entry.condition_config.min_kwh,
      };
    }
  }

  return byDim;
}

/**
 * 既有庫：若尚無 energy 規則，從 energy_settings.config 遷移一次。
 */
async function migrateEnergySettingsToAlertRules(pool) {
  const existing = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM alert_rules WHERE source = 'energy'`,
  );
  if ((existing.rows[0]?.cnt || 0) > 0) {
    return { migrated: false, reason: "rules_exist" };
  }

  const settings = await pool.query(
    `SELECT config FROM energy_settings WHERE id = 1 LIMIT 1`,
  );
  const config = settings.rows[0]?.config || {};
  const byDim = applyLegacySettingsToCatalog(config, listEnergyAlertRules());

  let insertedCount = 0;
  for (const rule of byDim.values()) {
    const result = await insertEnergyAlertRule(pool, rule);
    insertedCount += result.rowCount;
  }

  return { migrated: true, insertedCount };
}

module.exports = {
  syncEnergyAlertRuleCatalog,
  migrateEnergySettingsToAlertRules,
};
