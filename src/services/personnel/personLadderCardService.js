/**
 * 人員梯控卡片（person_ladder_cards）— 卡號／密碼／有效期取自人員主檔 access_control
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const {
  buildIsapiValidPayloadFromPlatformValidity,
} = require("../accessControl/accessControlValidityUtils");

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
  if (floors == null) floors = [];

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

const parseFloors = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
};

const parsePersonConfig = (raw) => {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
};

const getAccessControlFromPerson = (personRow) => {
  const config = parsePersonConfig(personRow?.config);
  return (config && config.access_control) || {};
};

const normalizeFloorsStorage = (raw) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.byLocation) {
    const byLocation = {};
    for (const [key, value] of Object.entries(raw.byLocation)) {
      const floors = parseFloors(value);
      if (floors.length) byLocation[String(key)] = floors;
    }
    return { byLocation };
  }
  const legacy = parseFloors(raw);
  if (legacy.length) {
    return { byLocation: {}, _legacy: legacy };
  }
  return { byLocation: {} };
};

const parseFloorsForLocation = (raw, locationId) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Array.isArray(raw._legacy) && raw._legacy.length) {
      return parseFloors(raw._legacy);
    }
    const map = raw.byLocation || {};
    const key = String(locationId);
    return parseFloors(map[key] ?? map[Number(locationId)]);
  }
  return parseFloors(raw);
};

const hasAnyFloors = (storage) => {
  if (Array.isArray(storage)) return storage.length > 0;
  if (storage && typeof storage === "object") {
    if (Array.isArray(storage._legacy) && storage._legacy.length) return true;
    const map = storage.byLocation || {};
    return Object.values(map).some((v) => parseFloors(v).length > 0);
  }
  return false;
};

const resolveSyncFields = (personRow, floors) => {
  const ac = getAccessControlFromPerson(personRow);
  const cardNo = ac.cardNo != null ? String(ac.cardNo).trim() : "";
  const valid = buildIsapiValidPayloadFromPlatformValidity(ac?.validity);
  const password =
    ac?.password != null && String(ac.password).trim() !== ""
      ? String(ac.password).trim()
      : null;
  const floorList = parseFloors(floors);
  return {
    cardNo,
    homeFloor: floorList[0] ?? 1,
    floors: floorList,
    cardType: 1,
    floorMode: "byte",
    cardPassword: password,
    validEnabled: Boolean(valid.enable),
    validBegin: valid.beginTime || null,
    validEnd: valid.endTime || null,
  };
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
  const personRows = await db.query(`SELECT config FROM persons WHERE id = ?`, [
    Number(personId),
  ]);
  const personRow = personRows?.[0] || null;
  const ac = getAccessControlFromPerson(personRow);
  const cardNo = String(ac.cardNo ?? input.cardNo ?? input.card_no ?? "").trim();
  if (!cardNo) {
    throwApiError(C.VALIDATION_CUSTOM, "請於卡片設定填寫卡號");
  }

  const floorsStorage = normalizeFloorsStorage(input.floors);
  if (!hasAnyFloors(floorsStorage)) {
    throwApiError(C.VALIDATION_CUSTOM, "請選擇授權樓層");
  }

  await assertCardNotOwnedByOther(cardNo, personId);

  const firstFloors = (() => {
    if (Array.isArray(floorsStorage._legacy) && floorsStorage._legacy.length) {
      return floorsStorage._legacy;
    }
    const all = Object.values(floorsStorage.byLocation || {}).flatMap((v) =>
      parseFloors(v),
    );
    return [...new Set(all)].sort((a, b) => a - b);
  })();
  const homeFloor = firstFloors[0] ?? 1;
  const cardType = 1;
  const floorMode = "byte";
  const storedFloors =
    floorsStorage.byLocation && Object.keys(floorsStorage.byLocation).length
      ? { byLocation: floorsStorage.byLocation }
      : { _legacy: firstFloors };

  const syncRaw = input.sdkSyncStatus ?? input.sdk_sync_status;
  const sdkSyncStatus =
    syncRaw && VALID_SYNC_STATUSES.has(String(syncRaw))
      ? String(syncRaw)
      : "pending";

  const floorsJson = JSON.stringify(storedFloors);
  const pid = Number(personId);
  const rowParams = [cardNo, homeFloor, floorsJson, cardType, floorMode, sdkSyncStatus];

  const existing = await getByPersonId(personId);
  const rows = existing
    ? await db.query(
        `UPDATE person_ladder_cards
         SET card_no = ?,
             home_floor = ?,
             floors = ?,
             card_type = ?,
             floor_mode = ?,
             card_password = NULL,
             valid_enabled = FALSE,
             valid_begin = NULL,
             valid_end = NULL,
             sdk_sync_status = ?,
             sdk_sync_error = NULL,
             sdk_synced_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE person_id = ?
         RETURNING *`,
        [...rowParams, pid],
      )
    : await db.query(
        `INSERT INTO person_ladder_cards (
           person_id, card_no, home_floor, floors, card_type, floor_mode,
           card_password, valid_enabled, valid_begin, valid_end, sdk_sync_status
         )
         VALUES (?, ?, ?, ?, ?, ?, NULL, FALSE, NULL, NULL, ?)
         RETURNING *`,
        [pid, ...rowParams],
      );

  const mapped = mapRow(rows?.[0]);
  const {
    syncPersonFloorAccessFromLadderFloors,
  } = require("../elevator/elevatorFloorAccessService");
  await syncPersonFloorAccessFromLadderFloors(personId, storedFloors);
  return mapped;
};

const removeForPerson = async (personId) => {
  const pid = Number(personId);
  await db.query(`DELETE FROM person_ladder_cards WHERE person_id = ?`, [pid]);
  await db.query(`DELETE FROM person_elevator_floor_access WHERE person_id = ?`, [
    pid,
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
  parseFloorsForLocation,
  resolveSyncFields,
};
