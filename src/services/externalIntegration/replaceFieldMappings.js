const mappingTables = {
  externalSync: ["external_sync_field_mappings", "config_id", "target_column"],
  recordExport: ["record_export_field_mappings", "rule_id", "header_label"],
};

// The caller holds the parent row lock in the same transaction.
async function replaceFieldMappings(query, kind, parentId, mappings) {
  const [table, parentKey, labelKey] = mappingTables[kind];
  await query(
    `DELETE FROM ${table}
     WHERE ${parentKey} = ? AND NOT (field_key = ANY(?::text[]))`,
    [parentId, mappings.map(({ fieldKey }) => fieldKey)],
  );
  await query(
    `INSERT INTO ${table} (${parentKey}, field_key, ${labelKey}, format, sort_order)
     SELECT ?, field_key, label, format, sort_order
     FROM jsonb_to_recordset(?::jsonb)
       AS input(field_key text, label text, format text, sort_order integer)
     ON CONFLICT (${parentKey}, field_key) DO UPDATE
       SET ${labelKey} = EXCLUDED.${labelKey}, format = EXCLUDED.format, sort_order = EXCLUDED.sort_order
     WHERE (${table}.${labelKey}, ${table}.format, ${table}.sort_order)
       IS DISTINCT FROM (EXCLUDED.${labelKey}, EXCLUDED.format, EXCLUDED.sort_order)`,
    [
      parentId,
      JSON.stringify(mappings.map(({ fieldKey, label, format }, index) => ({
        field_key: fieldKey,
        label,
        format,
        sort_order: index + 1,
      }))),
    ],
  );
}

module.exports = replaceFieldMappings;
