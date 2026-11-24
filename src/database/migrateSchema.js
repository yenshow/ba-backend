const { applySchemaPatches } = require("./schemaPatches");
const { ensureArchiveSchema } = require("./archiveSchema");
const syncDefinitions = require("../access/syncDefinitions");

async function migrateSchema(pool) {
  await applySchemaPatches(pool);
  await ensureArchiveSchema(pool);
  await syncDefinitions(pool);
}

async function main() {
  const db = require("./db");
  try {
    await migrateSchema(db.pool);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("資料庫升級失敗", error.message);
    process.exitCode = 1;
  });
}

module.exports = migrateSchema;
