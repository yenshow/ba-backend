/**
 * 地點 stats_reset_at 寫入與稽核（人流／車輛共用）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const logger = require("../../utils/logger").createLogger("Location Stats Reset");

const AUDIT_TABLES = {
  people_counting: "people_counting_reset_log",
  vehicle_access: "vehicle_access_reset_log",
};

/** DB snake_case 或 API camelCase */
function parseStatsResetAtField(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const v = c.stats_reset_at ?? c.statsResetAt ?? null;
  return v != null ? String(v) : null;
}

function parseActorUserId(userId) {
  const n = Number(userId);
  return userId != null && Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

async function writeLocationStatsResetAt(systemType, locationId, notFoundMessage) {
  const resetAt = new Date().toISOString();
  const rows = await db.query(
    `SELECT id, system_config FROM location_systems
     WHERE location_id = ? AND system_type = ?`,
    [locationId, systemType],
  );
  if (!rows?.length) {
    const code =
      systemType === "vehicle_access"
        ? C.VEHICLE_ACCESS_VALIDATION_FAILED
        : C.PEOPLE_COUNTING_VALIDATION_FAILED;
    throwApiError(code, notFoundMessage);
  }

  const rawCfg =
    typeof rows[0].system_config === "string"
      ? JSON.parse(rows[0].system_config)
      : rows[0].system_config || {};
  rawCfg.stats_reset_at = resetAt;
  await db.query(
    `UPDATE location_systems
     SET system_config = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(rawCfg), rows[0].id],
  );
  return resetAt;
}

async function appendResetAuditLog(scope, { locationId, resetAt, userId }) {
  const table = AUDIT_TABLES[scope];
  if (!table) return;
  const uid = parseActorUserId(userId);
  if (uid == null) return;
  try {
    await db.query(
      `INSERT INTO ${table} (location_id, reset_at, user_id) VALUES (?, ?, ?)`,
      [locationId, resetAt, uid],
    );
  } catch (error) {
    logger.warn("Reset 稽核寫入失敗（stats_reset_at 已更新）", {
      scope,
      locationId,
      userId: uid,
      error: error?.message || String(error),
    });
  }
}

/**
 * 寫入 stats_reset_at 並嘗試稽核（稽核失敗不影響回傳）
 * @param {{ systemType: string, scope: keyof AUDIT_TABLES, locationId: number, notFoundMessage: string, userId?: * }} params
 */
async function performLocationStatsReset({
  systemType,
  scope,
  locationId,
  notFoundMessage,
  userId = null,
}) {
  const resetAt = await writeLocationStatsResetAt(
    systemType,
    locationId,
    notFoundMessage,
  );
  await appendResetAuditLog(scope, { locationId, resetAt, userId });
  return resetAt;
}

module.exports = {
  parseStatsResetAtField,
  parseActorUserId,
  writeLocationStatsResetAt,
  appendResetAuditLog,
  performLocationStatsReset,
};
