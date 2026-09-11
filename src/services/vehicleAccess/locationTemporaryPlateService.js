/**
 * 地點臨時車牌（location_temporary_license_plates）— 不上人員主檔
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { normalizeListTypeToApi } = require("./isapiVehicleXmlParser");

const VALID_SYNC_STATUSES = new Set([
  "pending",
  "synced",
  "partial",
  "failed",
]);

function defaultEffectiveBegin() {
  return new Date();
}

function defaultEffectiveEnd() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d;
}

function parseTimestamp(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    location_id: row.location_id,
    plate_number: row.plate_number,
    plate_normalized: row.plate_normalized,
    list_type: normalizeListTypeToApi(row.list_type || "allowList"),
    effective_begin: row.effective_begin ?? null,
    effective_end: row.effective_end ?? null,
    display_name: row.display_name,
    isapi_sync_status: row.isapi_sync_status || "pending",
    isapi_sync_error: row.isapi_sync_error ?? null,
    isapi_synced_at: row.isapi_synced_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseInput(item = {}) {
  const plateNumber = String(
    item.plateNumber ?? item.plate_number ?? item.licensePlate ?? "",
  ).trim();
  const displayName = String(
    item.displayName ?? item.display_name ?? "",
  ).trim();
  const listType = normalizeListTypeToApi(item.listType ?? item.list_type);
  const effectiveBegin =
    parseTimestamp(item.effectiveBegin ?? item.effective_begin) ||
    defaultEffectiveBegin();
  const effectiveEnd =
    parseTimestamp(item.effectiveEnd ?? item.effective_end) ||
    defaultEffectiveEnd();

  return {
    plateNumber,
    displayName,
    listType,
    effectiveBegin,
    effectiveEnd,
  };
}

async function assertNotOwnedByPerson(plateNormalized) {
  if (!plateNormalized) return;
  const rows = await db.query(
    `SELECT person_id FROM person_license_plates WHERE plate_normalized = ? LIMIT 1`,
    [plateNormalized],
  );
  const owner = rows?.[0]?.person_id;
  if (owner != null) {
    throwApiError(
      C.PLATE_ALREADY_ASSIGNED,
      `車牌已綁定人員主檔（person_id=${owner}）`,
    );
  }
}

async function listByLocationId(locationId) {
  const locId = Number(locationId);
  if (!Number.isFinite(locId)) {
    throwApiError(C.BAD_REQUEST, "無效的地點 ID");
  }
  const rows = await db.query(
    `
      SELECT id, location_id, plate_number, plate_normalized,
             list_type, effective_begin, effective_end, display_name,
             isapi_sync_status, isapi_sync_error, isapi_synced_at,
             created_at, updated_at
      FROM location_temporary_license_plates
      WHERE location_id = ?
      ORDER BY id ASC
    `,
    [locId],
  );
  return (rows || []).map(mapRow);
}

async function getById(id) {
  const rows = await db.query(
    `SELECT * FROM location_temporary_license_plates WHERE id = ? LIMIT 1`,
    [Number(id)],
  );
  return mapRow(rows?.[0]);
}

async function updateSyncStatus(plateId, { status, error, syncedAt }) {
  const syncStatus =
    status && VALID_SYNC_STATUSES.has(String(status))
      ? String(status)
      : "pending";
  await db.query(
    `
      UPDATE location_temporary_license_plates
      SET isapi_sync_status = ?,
          isapi_sync_error = ?,
          isapi_synced_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [
      syncStatus,
      error != null ? String(error).slice(0, 500) : null,
      syncedAt || null,
      plateId,
    ],
  );
}

/**
 * Upsert 單筆臨時車牌（不推送設備；由 sync 層負責）
 * @param {number} locationId
 * @param {object} plateInput
 * @param {{ expectedMutation?: 'create'|'update'|null }} [options]
 * @returns {Promise<{ row: object, created: boolean }>}
 */
async function upsertForLocation(locationId, plateInput, options = {}) {
  const locId = Number(locationId);
  if (!Number.isFinite(locId)) {
    throwApiError(C.BAD_REQUEST, "無效的地點 ID");
  }

  const parsed = parseInput(plateInput);
  if (!parsed.plateNumber) {
    throwApiError(C.BAD_REQUEST, "請提供車牌");
  }
  if (!parsed.displayName) {
    throwApiError(C.BAD_REQUEST, "請提供姓名");
  }
  if (parsed.effectiveEnd <= parsed.effectiveBegin) {
    throwApiError(C.BAD_REQUEST, "結束時間須晚於開始時間");
  }

  const plateNormalized = normalizePlate(parsed.plateNumber);
  if (!plateNormalized) {
    throwApiError(C.BAD_REQUEST, "車牌格式無效");
  }

  await assertNotOwnedByPerson(plateNormalized);

  const existing = await db.query(
    `
      SELECT id FROM location_temporary_license_plates
      WHERE location_id = ? AND plate_normalized = ?
      LIMIT 1
    `,
    [locId, plateNormalized],
  );

  const existingId = existing?.[0]?.id ?? null;
  const expectedMutation = String(options.expectedMutation || "")
    .trim()
    .toLowerCase();
  if (expectedMutation === "create" && existingId != null) {
    throwApiError(C.PLATE_ALREADY_ASSIGNED, "此地點已有相同臨時車牌，請改用編輯");
  }
  if (expectedMutation === "update" && existingId == null) {
    throwApiError(C.NOT_FOUND, "找不到臨時車牌");
  }

  let created = false;
  if (existingId != null) {
    await db.query(
      `
        UPDATE location_temporary_license_plates
        SET plate_number = ?, list_type = ?,
            effective_begin = ?, effective_end = ?,
            display_name = ?,
            isapi_sync_status = 'pending', isapi_sync_error = NULL,
            isapi_synced_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [
        parsed.plateNumber,
        parsed.listType,
        parsed.effectiveBegin,
        parsed.effectiveEnd,
        parsed.displayName,
        existingId,
      ],
    );
  } else {
    created = true;
    await db.query(
      `
        INSERT INTO location_temporary_license_plates (
          location_id, plate_number, plate_normalized,
          list_type, effective_begin, effective_end, display_name,
          isapi_sync_status, isapi_sync_error, isapi_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)
      `,
      [
        locId,
        parsed.plateNumber,
        plateNormalized,
        parsed.listType,
        parsed.effectiveBegin,
        parsed.effectiveEnd,
        parsed.displayName,
      ],
    );
  }

  const rows = await db.query(
    `
      SELECT * FROM location_temporary_license_plates
      WHERE location_id = ? AND plate_normalized = ?
      LIMIT 1
    `,
    [locId, plateNormalized],
  );
  return { row: mapRow(rows?.[0]), created };
}

async function deleteById(locationId, plateId) {
  const locId = Number(locationId);
  const id = Number(plateId);
  if (!Number.isFinite(locId) || !Number.isFinite(id)) {
    throwApiError(C.BAD_REQUEST, "無效的參數");
  }
  const rows = await db.query(
    `
      SELECT * FROM location_temporary_license_plates
      WHERE id = ? AND location_id = ?
      LIMIT 1
    `,
    [id, locId],
  );
  const row = rows?.[0];
  if (!row) return null;
  await db.query(
    `DELETE FROM location_temporary_license_plates WHERE id = ? AND location_id = ?`,
    [id, locId],
  );
  return mapRow(row);
}

module.exports = {
  listByLocationId,
  getById,
  upsertForLocation,
  deleteById,
  updateSyncStatus,
};
