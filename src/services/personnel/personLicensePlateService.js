/**
 * 人員車牌（person_license_plates）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");

async function listByPersonId(personId) {
  const rows = await db.query(
    `SELECT id, person_id, plate_number, plate_normalized, created_at, updated_at
     FROM person_license_plates
     WHERE person_id = ?
     ORDER BY id ASC`,
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
    normalized.push({ plateNumber, plateNormalized });
  }

  await db.query(`DELETE FROM person_license_plates WHERE person_id = ?`, [
    pid,
  ]);

  for (const p of normalized) {
    await db.query(
      `INSERT INTO person_license_plates (person_id, plate_number, plate_normalized)
       VALUES (?, ?, ?)`,
      [pid, p.plateNumber, p.plateNormalized],
    );
  }

  return listByPersonId(pid);
}

module.exports = {
  listByPersonId,
  replacePlatesForPerson,
};
