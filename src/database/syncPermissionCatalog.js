const {
  getPermissionSeedRows,
  getAllPermissionCodes,
} = require("../config/permissionCatalog");

/** 將 permission_definitions 與 permissionCatalog SSOT 對齊 */
async function syncPermissionCatalog(pool) {
  const catalogCodes = getAllPermissionCodes();
  await pool.query(
    `DELETE FROM permission_definitions WHERE NOT (code = ANY($1::text[]))`,
    [catalogCodes],
  );
  for (const row of getPermissionSeedRows()) {
    if (!row.parent_code) {
      await pool.query(
        `INSERT INTO permission_definitions (code, category, parent_id, name, sort_order)
         VALUES ($1, $2, NULL, $3, $4)
         ON CONFLICT (code) DO UPDATE SET
           category = EXCLUDED.category,
           parent_id = NULL,
           name = EXCLUDED.name,
           sort_order = EXCLUDED.sort_order`,
        [row.code, row.category, row.name, row.sort_order],
      );
      continue;
    }
    await pool.query(
      `INSERT INTO permission_definitions (code, category, parent_id, name, sort_order)
       SELECT $1, $2, p.id, $3, $4
       FROM permission_definitions p WHERE p.code = $5
       ON CONFLICT (code) DO UPDATE SET
         category = EXCLUDED.category,
         parent_id = (SELECT id FROM permission_definitions WHERE code = $5),
         name = EXCLUDED.name,
         sort_order = EXCLUDED.sort_order`,
      [row.code, row.category, row.name, row.sort_order, row.parent_code],
    );
  }
}

module.exports = syncPermissionCatalog;
