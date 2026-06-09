/**
 * 人員梯控卡片（person_ladder_cards）— 比照 person_license_plates
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

const VALID_SYNC_STATUSES = new Set([
  "pending",
  "synced",
  "partial",
  "failed",
]);

const mapRow = (row) => {
  if (!row) return null;
  let floors = row.floors;
  if (typeof floors === "string") {
    try {
      floors = JSON.parse(floors);
    } catch {
      floors = [];
    }
  }
  if (!Array.isArray(floors)) floors = [];

  return {
    id: row.id,
    person_id: row.person_id,
    card_no: row.card_no,
    home_floor: row.home_floor,
    floors,
    card_type: row.card_type,
    floor_mode: row.floor_mode || "byte",
    card_password: row.card_password ?? null,
    valid_enabled: !!row.valid_enabled,
    valid_begin: row.valid_begin ?? null,
    valid_end: row.valid_end ?? null,
    sdk_sync_status: row.sdk_sync_status || "pending",
    sdk_sync_error: row.sdk_sync_error ?? null,
    sdk_synced_at: row.sdk_synced_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const parseTimestamp = (value) => {
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const parseFloors = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
};

const assertCardNotOwnedByOther = async (cardNo, personId) => {
  const normalized = String(cardNo || "").trim();
  if (!normalized) return;
  const rows = await db.query(
    `SELECT person_id FROM person_ladder_cards WHERE card_no = ? LIMIT 1`,
    [normalized],
  );
  const owner = rows?.[0]?.person_id;
  if (owner != null && Number(owner) !== Number(personId)) {
    throwApiError(
      C.VALIDATION_CUSTOM,
      `梯控卡號已被其他人員使用（person_id=${owner}）`,
    );
  }
};

const getByPersonId = async (personId) => {
  const rows = await db.query(
    `SELECT * FROM person_ladder_cards WHERE person_id = ? LIMIT 1`,
    [Number(personId)],
  );
  return mapRow(rows?.[0]);
};

const upsertForPerson = async (personId, input = {}) => {
  const cardNo = String(input.cardNo ?? input.card_no ?? "").trim();
  if (!cardNo) {
    throwApiError(C.VALIDATION_CUSTOM, "請提供 cardNo");
  }

  const floors = parseFloors(input.floors);
  if (floors.length === 0) {
    throwApiError(C.VALIDATION_CUSTOM, "請提供 floors 授權樓層");
  }

  await assertCardNotOwnedByOther(cardNo, personId);

  const homeFloor = Number(input.homeFloor ?? input.home_floor ?? 1);
  const cardType = Number(input.cardType ?? input.card_type ?? 1);
  const floorMode = String(input.floorMode ?? input.floor_mode ?? "byte");
  const cardPassword =
    input.cardPassword ?? input.card_password ?? null;
  const validEnabled = Boolean(
    input.validEnabled ?? input.valid_enabled ?? false,
  );
  const validBegin = parseTimestamp(
    input.validBegin ?? input.valid_begin,
  );
  const validEnd = parseTimestamp(input.validEnd ?? input.valid_end);

  const syncRaw = input.sdkSyncStatus ?? input.sdk_sync_status;
  const sdkSyncStatus =
    syncRaw && VALID_SYNC_STATUSES.has(String(syncRaw))
      ? String(syncRaw)
      : "pending";

  const existing = await getByPersonId(personId);
  if (existing) {
    const rows = await db.query(
      `UPDATE person_ladder_cards
       SET card_no = ?,
           home_floor = ?,
           floors = ?,
           card_type = ?,
           floor_mode = ?,
           card_password = ?,
           valid_enabled = ?,
           valid_begin = ?,
           valid_end = ?,
           sdk_sync_status = ?,
           sdk_sync_error = NULL,
           sdk_synced_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE person_id = ?
       RETURNING *`,
      [
        cardNo,
        homeFloor,
        JSON.stringify(floors),
        cardType,
        floorMode,
        cardPassword,
        validEnabled,
        validBegin,
        validEnd,
        sdkSyncStatus,
        Number(personId),
      ],
    );
    return mapRow(rows?.[0]);
  }

  const rows = await db.query(
    `INSERT INTO person_ladder_cards (
       person_id, card_no, home_floor, floors, card_type, floor_mode,
       card_password, valid_enabled, valid_begin, valid_end, sdk_sync_status
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [
      Number(personId),
      cardNo,
      homeFloor,
      JSON.stringify(floors),
      cardType,
      floorMode,
      cardPassword,
      validEnabled,
      validBegin,
      validEnd,
      sdkSyncStatus,
    ],
  );
  return mapRow(rows?.[0]);
};

const removeForPerson = async (personId) => {
  await db.query(`DELETE FROM person_ladder_cards WHERE person_id = ?`, [
    Number(personId),
  ]);
  return { success: true };
};

const getPersonIdByCardNo = async (cardNo) => {
  const normalized = String(cardNo || "").trim();
  if (!normalized) return null;
  const rows = await db.query(
    `SELECT person_id FROM person_ladder_cards WHERE card_no = ? LIMIT 1`,
    [normalized],
  );
  const personId = rows?.[0]?.person_id;
  return personId != null ? Number(personId) : null;
};

module.exports = {
  getByPersonId,
  upsertForPerson,
  removeForPerson,
  getPersonIdByCardNo,
  mapRow,
};
