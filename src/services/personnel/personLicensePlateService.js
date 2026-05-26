/**
 * 人員車牌（person_license_plates）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");

async function listByPersonId(personId) {
  const rows = await db.query(
    `SELECT id, person_id, plate_number, plate_normalized, is_primary, created_at, updated_at
     FROM person_license_plates
     WHERE person_id = ?
     ORDER BY is_primary DESC, id ASC`,
    [personId],
  );
  return rows || [];
}

async function replacePlatesForPerson(personId, platesInput) {
  const pid = Number(personId);
  if (!Number.isFinite(pid)) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "無效的人員 ID");
  }

  const normalized = [];
  const seen = new Set();
  for (const item of Array.isArray(platesInput) ? platesInput : []) {
    const raw =
      typeof item === "string"
        ? item
        : item?.plateNumber ?? item?.plate_number ?? "";
    const plateNumber = String(raw).trim();
    if (!plateNumber) continue;
    const plateNormalized = normalizePlate(plateNumber);
    if (!plateNormalized || seen.has(plateNormalized)) continue;
    seen.add(plateNormalized);
    const isPrimary = !!(
      typeof item === "object" &&
      item &&
      (item.isPrimary === true || item.is_primary === true)
    );
    normalized.push({ plateNumber, plateNormalized, isPrimary });
  }

  if (normalized.length > 0 && !normalized.some((p) => p.isPrimary)) {
    normalized[0].isPrimary = true;
  }
  for (const p of normalized) {
    if (p.isPrimary) {
      for (const o of normalized) {
        if (o !== p) o.isPrimary = false;
      }
      break;
    }
  }

  await db.query(`DELETE FROM person_license_plates WHERE person_id = ?`, [
    pid,
  ]);

  for (const p of normalized) {
    await db.query(
      `INSERT INTO person_license_plates (person_id, plate_number, plate_normalized, is_primary)
       VALUES (?, ?, ?, ?)`,
      [pid, p.plateNumber, p.plateNormalized, p.isPrimary],
    );
  }

  return listByPersonId(pid);
}

module.exports = {
  listByPersonId,
  replacePlatesForPerson,
};
