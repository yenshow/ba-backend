/**
 * 人員車牌（person_license_plates）— 含 ISAPI 四欄位，與門禁 Valid 分離
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { normalizeListTypeToApi } = require("../vehicleAccess/isapiVehicleTrafficXmlParser");

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
  d.setFullYear(d.getFullYear() + 5);
  return d;
}

function parseTimestamp(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapPlateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    person_id: row.person_id,
    plate_number: row.plate_number,
    plate_normalized: row.plate_normalized,
    list_type: normalizeListTypeToApi(row.list_type || "allowList"),
    effective_begin: row.effective_begin ?? null,
    effective_end: row.effective_end ?? null,
    isapi_sync_status: row.isapi_sync_status || "pending",
    isapi_sync_error: row.isapi_sync_error ?? null,
    isapi_synced_at: row.isapi_synced_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parsePlateInput(item) {
  if (typeof item === "string") {
    const plateNumber = String(item).trim();
    return {
      plateNumber,
      listType: "allowList",
      effectiveBegin: defaultEffectiveBegin(),
      effectiveEnd: defaultEffectiveEnd(),
      isapiSyncStatus: "pending",
    };
  }

  const plateNumber = String(
    item?.plateNumber ?? item?.plate_number ?? "",
  ).trim();
  const listType = normalizeListTypeToApi(item?.listType ?? item?.list_type);
  const effectiveBegin =
    parseTimestamp(item?.effectiveBegin ?? item?.effective_begin) ||
    defaultEffectiveBegin();
  const effectiveEnd =
    parseTimestamp(item?.effectiveEnd ?? item?.effective_end) ||
    defaultEffectiveEnd();

  const syncRaw = item?.isapiSyncStatus ?? item?.isapi_sync_status;
  const isapiSyncStatus =
    syncRaw && VALID_SYNC_STATUSES.has(String(syncRaw))
      ? String(syncRaw)
      : "pending";

  return {
    plateNumber,
    listType,
    effectiveBegin,
    effectiveEnd,
    isapiSyncStatus,
  };
}

async function assertPlateNotOwnedByOther(plateNormalized, personId) {
  if (!plateNormalized) return;
  const rows = await db.query(
    `SELECT person_id FROM person_license_plates WHERE plate_normalized = ? LIMIT 1`,
    [plateNormalized],
  );
  const owner = rows?.[0]?.person_id;
  if (owner != null && Number(owner) !== Number(personId)) {
    throwApiError(
      C.PLATE_ALREADY_ASSIGNED,
      `車牌已被其他人員使用（person_id=${owner}）`,
    );
  }
}

async function listByPersonId(personId) {
  const rows = await db.query(
    `SELECT id, person_id, plate_number, plate_normalized,
            list_type, effective_begin, effective_end,
            isapi_sync_status, isapi_sync_error, isapi_synced_at,
            created_at, updated_at
     FROM person_license_plates
     WHERE person_id = ?
     ORDER BY id ASC`,
    [personId],
  );
  return (rows || []).map(mapPlateRow);
}

async function updateSyncStatus(plateId, { status, error, syncedAt }) {
  await db.query(
    `
      UPDATE person_license_plates
      SET isapi_sync_status = ?,
          isapi_sync_error = ?,
          isapi_synced_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [
      status,
      error != null ? String(error).slice(0, 500) : null,
      syncedAt || null,
      plateId,
    ],
  );
}

const MAX_LICENSE_PLATES_PER_PERSON = 5;

async function replacePlatesForPerson(personId, platesInput) {
  const pid = Number(personId);
  if (!Number.isFinite(pid)) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "無效的人員 ID");
  }

  const normalized = [];
  const seen = new Set();
  for (const item of Array.isArray(platesInput) ? platesInput : []) {
    const parsed = parsePlateInput(item);
    if (!parsed.plateNumber) continue;
    const plateNormalized = normalizePlate(parsed.plateNumber);
    if (!plateNormalized || seen.has(plateNormalized)) continue;
    await assertPlateNotOwnedByOther(plateNormalized, pid);
    seen.add(plateNormalized);
    normalized.push({ ...parsed, plateNormalized });
  }

  if (normalized.length > MAX_LICENSE_PLATES_PER_PERSON) {
    throwApiError(
      C.PERSONNEL_VALIDATION_FAILED,
      `車牌最多 ${MAX_LICENSE_PLATES_PER_PERSON} 筆`,
    );
  }

  await db.query(`DELETE FROM person_license_plates WHERE person_id = ?`, [
    pid,
  ]);

  for (const p of normalized) {
    await db.query(
      `
        INSERT INTO person_license_plates (
          person_id, plate_number, plate_normalized,
          list_type, effective_begin, effective_end,
          isapi_sync_status, isapi_sync_error, isapi_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `,
      [
        pid,
        p.plateNumber,
        p.plateNormalized,
        p.listType,
        p.effectiveBegin,
        p.effectiveEnd,
        p.isapiSyncStatus,
      ],
    );
  }

  return listByPersonId(pid);
}

/**
 * 單筆 upsert（車牌管理綁定人員用）
 */
async function upsertPlateForPerson(personId, plateInput, options = {}) {
  const pid = Number(personId);
  if (!Number.isFinite(pid)) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "無效的人員 ID");
  }

  const parsed = parsePlateInput(plateInput);
  if (!parsed.plateNumber) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "請提供車牌");
  }
  const plateNormalized = normalizePlate(parsed.plateNumber);
  if (!plateNormalized) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "車牌格式無效");
  }

  await assertPlateNotOwnedByOther(plateNormalized, pid);

  const syncStatus =
    options.isapiSyncStatus ||
    parsed.isapiSyncStatus ||
    (options.markSynced ? "synced" : "pending");
  const syncedAt = options.markSynced ? new Date() : null;

  const existing = await db.query(
    `SELECT id FROM person_license_plates WHERE plate_normalized = ? LIMIT 1`,
    [plateNormalized],
  );

  if (existing?.[0]?.id) {
    await db.query(
      `
        UPDATE person_license_plates
        SET person_id = ?, plate_number = ?, list_type = ?,
            effective_begin = ?, effective_end = ?,
            isapi_sync_status = ?, isapi_sync_error = NULL,
            isapi_synced_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [
        pid,
        parsed.plateNumber,
        parsed.listType,
        parsed.effectiveBegin,
        parsed.effectiveEnd,
        syncStatus,
        syncedAt,
        existing[0].id,
      ],
    );
  } else {
    await db.query(
      `
        INSERT INTO person_license_plates (
          person_id, plate_number, plate_normalized,
          list_type, effective_begin, effective_end,
          isapi_sync_status, isapi_sync_error, isapi_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `,
      [
        pid,
        parsed.plateNumber,
        plateNormalized,
        parsed.listType,
        parsed.effectiveBegin,
        parsed.effectiveEnd,
        syncStatus,
        syncedAt,
      ],
    );
  }

  const rows = await db.query(
    `SELECT * FROM person_license_plates WHERE plate_normalized = ? LIMIT 1`,
    [plateNormalized],
  );
  return mapPlateRow(rows?.[0]);
}

async function deleteByPlateNormalized(plateNumber) {
  const plateNormalized = normalizePlate(plateNumber);
  if (!plateNormalized) return null;
  const rows = await db.query(
    `SELECT * FROM person_license_plates WHERE plate_normalized = ? LIMIT 1`,
    [plateNormalized],
  );
  if (!rows?.[0]) return null;
  await db.query(`DELETE FROM person_license_plates WHERE plate_normalized = ?`, [
    plateNormalized,
  ]);
  return mapPlateRow(rows[0]);
}

async function findBindingsByPlates(plateNumbers) {
  const raw = Array.isArray(plateNumbers) ? plateNumbers : [plateNumbers];
  const normalized = Array.from(
    new Set(raw.map((p) => normalizePlate(p)).filter(Boolean)),
  );
  if (normalized.length === 0) return [];

  const placeholders = normalized.map(() => "?").join(",");
  const rows = await db.query(
    `
      SELECT plp.plate_normalized, plp.plate_number, plp.person_id,
             p.employee_no, p.full_name
      FROM person_license_plates plp
      INNER JOIN persons p ON p.id = plp.person_id
      WHERE plp.plate_normalized IN (${placeholders})
    `,
    normalized,
  );
  return (rows || []).map((row) => ({
    plate_normalized: row.plate_normalized,
    plate_number: row.plate_number,
    person_id: row.person_id,
    employee_no: row.employee_no,
    full_name: row.full_name,
  }));
}

module.exports = {
  listByPersonId,
  replacePlatesForPerson,
  upsertPlateForPerson,
  updateSyncStatus,
  deleteByPlateNormalized,
  findBindingsByPlates,
};
