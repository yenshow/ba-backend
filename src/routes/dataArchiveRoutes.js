const express = require("express");
const db = require("../database/db");
const { authenticate, requirePlatformAdmin } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrors");
const { archiveLabels } = require("../database/archiveSchema");

const router = express.Router();
router.use(authenticate, requirePlatformAdmin);

function getBeforeCursor(req) {
  const value = req.query.before;
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throwApiError(C.VALIDATION_REQUIRED, "分頁游標無效");
  }
  return value;
}

function getTable(req) {
  const { type } = req.params;
  if (!archiveLabels.has(type)) {
    throwApiError(C.NOT_FOUND, "找不到封存資料類型");
  }
  return type;
}

router.get("/audit", asyncHandler(async (req, res) => {
  const before = getBeforeCursor(req);
  const rows = await db.query(
    `SELECT id, occurred_at, actor_id, actor_username, request_id, action,
            target_type, target_id, reason, details
     FROM management_audit_events WHERE (?::bigint IS NULL OR id < ?::bigint)
     ORDER BY id DESC LIMIT 101`,
    [before, before],
  );
  res.sendSuccess({ items: rows.slice(0, 100), hasMore: rows.length > 100 });
}));

router.get("/:type", asyncHandler(async (req, res) => {
  const table = getTable(req);
  const before = getBeforeCursor(req);
  const deviceSyncPending = table === "persons"
    ? "EXISTS (SELECT 1 FROM archived_person_revocations j WHERE j.person_id = t.id AND j.completed_at IS NULL)"
    : "FALSE";
  const rows = await db.query(
    `SELECT id, archived_at, coalesce(t.${archiveLabels.get(table)}::text, id::text) AS label,
            ${deviceSyncPending} AS device_sync_pending
     FROM ${table} t
     WHERE archived_at IS NOT NULL AND (?::bigint IS NULL OR id < ?::bigint)
     ORDER BY id DESC LIMIT 101`,
    [before, before],
  );
  res.sendSuccess({ items: rows.slice(0, 100), hasMore: rows.length > 100 });
}));

const restorePrerequisites = {
  alert_linkages: "rule_id IN (SELECT id FROM active_alert_rules)",
  locations: "zone_id IN (SELECT id FROM active_zones)",
  location_systems: "location_id IN (SELECT id FROM active_locations)",
  person_groups: "(parent_id IS NULL OR parent_id IN (SELECT id FROM active_person_groups))",
  persons: `(person_group_id IS NULL OR person_group_id IN (SELECT id FROM active_person_groups))
    AND NOT EXISTS (SELECT 1 FROM archived_person_revocations j WHERE j.person_id = persons.id AND j.completed_at IS NULL)`,
  roll_call_rules: "location_id IN (SELECT location_id FROM active_location_systems WHERE system_type = 'roll_call')",
  external_sync_configs: "event_type <> 'people_counting'",
  record_export_rules: "event_type <> 'people_counting'",
};

router.post("/:type/:id/restore", asyncHandler(async (req, res) => {
  const table = getTable(req);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) {
    throwApiError(C.VALIDATION_REQUIRED, "資料識別碼無效");
  }
  if (typeof req.body?.reason !== "string" || !req.body.reason.trim() || req.body.reason.trim().length > 500) {
    throwApiError(C.VALIDATION_REQUIRED, "請填寫還原原因，最多 500 字");
  }

  const row = await db.transaction(async (query) => {
    const restoreFields = {
      devices: "id, model_id, type_code, config",
      location_systems: "id, system_type, system_config",
    };
    const [row] = await query(
      `SELECT ${restoreFields[table] || "id"} FROM ${table} WHERE id = ? AND archived_at IS NOT NULL FOR UPDATE`,
      [id],
    );
    if (!row) throwApiError(C.NOT_FOUND, "找不到封存資料");

    const quota = require("../services/license/licenseQuotaService");
    if (table === "devices") {
      const [model] = await query("SELECT category_code, config FROM active_device_models WHERE id = ?", [row.model_id]);
      if (!model) throwApiError(C.CONFLICT, "請先還原設備型號");
      const { featureKey } = quota.applyQuotaFeatureToConfig({
        typeCode: row.type_code,
        categoryCode: model?.category_code,
        modelConfig: model?.config,
        deviceConfig: row.config,
      });
      await quota.assertDeviceWriteQuota({ featureKey, deviceConfig: row.config, modelConfig: model?.config });
    } else if (table === "location_systems") {
      await require("../services/location/locationSystemOps").assertSystemLicensed(row.system_type);
      await quota.assertSystemQuotaWithinLimit({ query, systemType: row.system_type, nextConfig: row.system_config });
    }

    const restored = await query(
      `UPDATE ${table} SET archived_at = NULL WHERE id = ?
       AND (${restorePrerequisites[table] || "TRUE"}) RETURNING id`,
      [id],
    );
    if (!restored.length) throwApiError(C.CONFLICT, "請先還原關聯資料");
    return row;
  }).catch((error) => {
    if (error.code === "23505") throwApiError(C.CONFLICT, "已有使用中的同類資料，請先處理後再還原");
    throw error;
  });

  if (["devices", "locations", "zones", "location_systems"].includes(table)) {
    require("../services/location/locationShared").refreshAfterLocationOrZoneDelete();
  }
  if (table === "devices" && row.type_code === "camera") {
    await require("../services/communication/mediaMTXConfigSyncService").generateConfigFile().catch((error) =>
      require("../utils/logger").warn("還原設備後更新影像設定失敗", { deviceId: id, code: error.code }),
    );
  }
  if (table === "external_sync_configs") global.__externalSyncHandle?.reschedule?.();
  res.sendSuccess({ id, message: "已還原封存資料" });
}));

module.exports = router;
