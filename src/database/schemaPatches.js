const logger = require("../utils/logger");

const patchLogger = logger.createLogger("schemaPatches");

const PERSON_SYNC_JOB_TYPES_SQL = `
  CHECK (job_type IN ('sync_location', 'sync_all_locations', 'elevator_sync_location'))
`;

/** person_sync_jobs 支援電梯樓層同步 job_type（idempotent） */
async function patchPersonSyncJobTypes(pool) {
  if (!pool) return;

  await pool.query(`
    ALTER TABLE person_sync_jobs
    DROP CONSTRAINT IF EXISTS person_sync_jobs_job_type_check
  `);
  await pool.query(`
    ALTER TABLE person_sync_jobs
    ADD CONSTRAINT person_sync_jobs_job_type_check
    ${PERSON_SYNC_JOB_TYPES_SQL}
  `);
}

/**
 * 啟動時套用增量 schema 修補（initSchema 子集，避免舊庫缺 migration）
 */
async function runSchemaPatches(pool) {
  await patchPersonSyncJobTypes(pool);
  patchLogger.info("person_sync_jobs job_type 已確認含 elevator_sync_location", {
    module: "schemaPatches",
  });
}

module.exports = { patchPersonSyncJobTypes, runSchemaPatches };
