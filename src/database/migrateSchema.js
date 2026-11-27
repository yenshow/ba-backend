const { applySchemaPatches } = require("./schemaPatches");
const { ensureArchiveSchema } = require("./archiveSchema");
const {
  syncDeviceModelCatalog,
  repairDeviceModelCatalogConfig,
} = require("./syncDeviceModelCatalog");
const syncDefinitions = require("../access/syncDefinitions");
const logger = require("../utils/logger");

async function migrateSchema(pool) {
  await applySchemaPatches(pool);
  // archived_at 等封存欄位須先就緒，再同步／修補 device_models catalog
  await ensureArchiveSchema(pool);
  const deviceModelSync = await syncDeviceModelCatalog(pool);
  const deviceModelRepair = await repairDeviceModelCatalogConfig(pool);
  logger.info("device_models catalog 已同步（migrateSchema）", {
    module: "migrateSchema",
    ...deviceModelSync,
    ...deviceModelRepair,
  });
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
