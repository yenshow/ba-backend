async function scheduleRulesUnchanged(query, { rulesTable, locationsTable, startColumn, endColumn }, rules) {
  // Serialize replacements so the comparison and subsequent writes use the same rule set.
  await query(`LOCK TABLE ${rulesTable} IN EXCLUSIVE MODE`);
  const [result] = await query(
    `
      SELECT coalesce((
        SELECT jsonb_agg(jsonb_build_array(
          coalesce(r.name, ''), r.days_of_week, r.${startColumn}, r.${endColumn}, r.enabled,
          coalesce((
            SELECT jsonb_agg(l.location_id ORDER BY l.location_id)
            FROM ${locationsTable} l WHERE l.rule_id = r.id
          ), '[]'::jsonb)
        ) ORDER BY r.id)
        FROM active_${rulesTable} r
      ), '[]'::jsonb) = coalesce((
        SELECT jsonb_agg(jsonb_build_array(
          coalesce(rule->>'name', ''), rule->'days', (rule->>'start')::time,
          (rule->>'end')::time, rule->'enabled', rule->'locationIds'
        ) ORDER BY position)
        FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS input(rule, position)
      ), '[]'::jsonb) AS unchanged
    `,
    [JSON.stringify(rules)],
  );
  return result.unchanged;
}

module.exports = scheduleRulesUnchanged;
