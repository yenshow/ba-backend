/**
 * 既有資料庫 schema 增量修補（啟動時執行；新裝仍由 initSchema 建立完整 enum）。
 */
const logger = require("../utils/logger").createLogger("schemaPatches");

/** 與 initSchema `alert_source`、alertService.ALERT_SOURCES 對齊 */
const ALERT_SOURCE_ENUM_VALUES = [
  "device",
  "environment",
  "lighting",
  "people_counting",
  "drainage",
  "power",
  "hvac",
  "air_circulation",
  "fire",
  "emergency_rescue",
  "smoke_alarm",
  "security",
];

const sanitizeEnumName = (name) => String(name || "").replace(/[^a-z_]/gi, "");
const sanitizeEnumValue = (value) => String(value || "").replace(/'/g, "''");

async function ensureEnumValue(pool, enumName, value) {
  const safeEnum = sanitizeEnumName(enumName);
  const safeValue = sanitizeEnumValue(value);
  if (!safeEnum || !safeValue) return;

  await pool.query(`
    DO $do$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = '${safeEnum}')
         AND NOT EXISTS (
           SELECT 1
           FROM pg_enum e
           INNER JOIN pg_type t ON e.enumtypid = t.oid
           WHERE t.typname = '${safeEnum}'
             AND e.enumlabel = '${safeValue}'
         ) THEN
        ALTER TYPE ${safeEnum} ADD VALUE '${safeValue}';
      END IF;
    END
    $do$;
  `);
}

async function ensureAlertSourceEnumValues(pool) {
  for (const value of ALERT_SOURCE_ENUM_VALUES) {
    await ensureEnumValue(pool, "alert_source", value);
  }
}

async function applySchemaPatches(pool) {
  if (!pool) return;
  await ensureAlertSourceEnumValues(pool);
  logger.info("schema patches 已套用", { module: "schemaPatches" });
}

module.exports = {
  ALERT_SOURCE_ENUM_VALUES,
  ensureEnumValue,
  ensureAlertSourceEnumValues,
  applySchemaPatches,
};
