const {
  getPermissionSeedRows,
  getAllPermissionCodes,
} = require("./catalog");

/** 將舊權限碼的 user overrides 遷移至新碼（須在刪除舊碼前執行） */
async function migratePermissionOverrides(pool, oldCode, newCode) {
  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, granted)
     SELECT uo.user_id, new_p.id, uo.granted
     FROM user_permission_overrides uo
     INNER JOIN permission_definitions old_p
       ON old_p.id = uo.permission_id AND old_p.code = $1
     INNER JOIN permission_definitions new_p ON new_p.code = $2
     ON CONFLICT (user_id, permission_id) DO UPDATE SET granted = EXCLUDED.granted`,
    [oldCode, newCode],
  );
}

/** 將 permission_definitions 與 catalog SSOT 對齊 */
async function syncDefinitions(pool) {
  const catalogCodes = getAllPermissionCodes();
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

  await migratePermissionOverrides(
    pool,
    "system.elevator.card.manage",
    "system.elevator.floor.manage",
  );

  await pool.query(
    `DELETE FROM permission_definitions WHERE NOT (code = ANY($1::text[]))`,
    [catalogCodes],
  );
}

async function runCli() {
  const db = require("../database/db");
  try {
    const connected = await db.testConnection();
    if (!connected) {
      console.error("❌ 資料庫連線失敗，無法同步權限定義");
      process.exit(1);
    }
    console.log("正在同步權限定義（catalog → permission_definitions）…");
    await syncDefinitions(db.pool);
    console.log("✅ 權限定義同步完成");
  } catch (error) {
    console.error("❌ 權限定義同步失敗:", error?.message || error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  runCli();
}

module.exports = syncDefinitions;
