/**
 * 電梯地點樓層授權（person_elevator_floor_access）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const elevatorService = require("./elevatorService");
const { normalizeElevatorFloorConfig } = require("./elevatorFloorConfig");

const personLadderCardService = require("../personnel/personLadderCardService");
const {
  formatPersonLabel,
  formatMissingPersonIdLabels,
} = require("../../utils/personDisplayUtils");

const parseFloorsJson = (raw) => {
  if (Array.isArray(raw)) {
    return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parseFloorsJson(parsed);
    } catch {
      return [];
    }
  }
  return [];
};

const parseFloorsForLocation = (raw, locationId) =>
  personLadderCardService.parseFloorsForLocation(raw, locationId);

async function getStoredAccessRows(locationId) {
  return db.query(
    `SELECT person_id, floor_index
     FROM person_elevator_floor_access
     WHERE location_id = ?
     ORDER BY floor_index ASC, person_id ASC`,
    [Number(locationId)],
  );
}

async function hasStoredAccess(locationId) {
  const rows = await db.query(
    `SELECT 1 FROM person_elevator_floor_access WHERE location_id = ? LIMIT 1`,
    [Number(locationId)],
  );
  return (rows || []).length > 0;
}

async function getActivePersonsWithLadderFloors() {
  const rows = await db.query(
    `SELECT p.id, p.employee_no, p.full_name, p.person_group_id, pg.name AS group_name,
            plc.floors
     FROM persons p
     LEFT JOIN person_groups pg ON p.person_group_id = pg.id
     INNER JOIN person_ladder_cards plc ON plc.person_id = p.id
     WHERE p.status = 'active'
     ORDER BY p.employee_no ASC`,
  );
  return (rows || []).map((row) => ({
    id: row.id,
    employee_no: row.employee_no,
    full_name: row.full_name,
    person_group_id: row.person_group_id,
    group_name: row.group_name,
    floorsRaw: row.floors,
  }));
}

function buildFloorSlots(floorCount, floorNames) {
  return Array.from({ length: floorCount }, (_, i) => ({
    index: i + 1,
    name: floorNames[i] || `Floor ${String(i + 1).padStart(2, "0")}`,
    personIds: [],
  }));
}

function applyRowsToFloors(floors, rows) {
  const personIdsByFloor = new Map();
  for (const row of rows || []) {
    const floorIndex = Number(row.floor_index);
    const personId = Number(row.person_id);
    if (!Number.isFinite(floorIndex) || !Number.isFinite(personId)) continue;
    if (!personIdsByFloor.has(floorIndex)) personIdsByFloor.set(floorIndex, []);
    personIdsByFloor.get(floorIndex).push(personId);
  }
  return floors.map((floor) => ({
    ...floor,
    personIds: personIdsByFloor.get(floor.index) || [],
  }));
}

function buildDefaultAssignments(
  floorCount,
  persons,
  floorNames = [],
  locationId = null,
) {
  const floors = buildFloorSlots(floorCount, floorNames);
  const byFloor = new Map(floors.map((f) => [f.index, []]));
  for (const person of persons) {
    const defaults =
      locationId != null
        ? parseFloorsForLocation(person.floorsRaw, locationId)
        : parseFloorsJson(person.floorsRaw);
    for (const floorIndex of defaults) {
      if (floorIndex < 1 || floorIndex > floorCount) continue;
      byFloor.get(floorIndex).push(Number(person.id));
    }
  }
  return floors.map((f) => ({
    ...f,
    personIds: byFloor.get(f.index) || [],
  }));
}

async function getFloorAccess(locationId) {
  const { location } = await elevatorService.getElevatorLocationById(locationId);
  const config = elevatorService.getElevatorConfig(location);
  const { floorCount, floorNames } = normalizeElevatorFloorConfig(config);

  if (floorCount == null || floorCount < 1) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "此地點尚未設定樓層");
  }

  const stored = await hasStoredAccess(locationId);
  let floors = buildFloorSlots(floorCount, floorNames);

  if (stored) {
    const rows = await getStoredAccessRows(locationId);
    floors = applyRowsToFloors(floors, rows);
    return { floors, defaultsApplied: false, hasStoredAccess: true };
  }

  const persons = await getActivePersonsWithLadderFloors();
  const defaultFloors = buildDefaultAssignments(
    floorCount,
    persons,
    floorNames,
    locationId,
  );
  floors = buildFloorSlots(floorCount, floorNames).map((f, i) => ({
    ...f,
    personIds: defaultFloors[i]?.personIds || [],
  }));

  return { floors, defaultsApplied: true, hasStoredAccess: false };
}

async function replaceFloorAccess(locationId, assignments = []) {
  const { location } = await elevatorService.getElevatorLocationById(locationId);
  const config = elevatorService.getElevatorConfig(location);
  const { floorCount } = normalizeElevatorFloorConfig(config);

  if (floorCount == null || floorCount < 1) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "此地點尚未設定樓層");
  }

  const list = Array.isArray(assignments) ? assignments : [];
  const pairs = [];

  for (const item of list) {
    const floorIndex = Number(item.floorIndex ?? item.floor_index);
    if (!Number.isFinite(floorIndex) || floorIndex < 1 || floorIndex > floorCount) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `樓層索引無效：${item.floorIndex ?? item.floor_index}`,
      );
    }
    const personIds = Array.isArray(item.personIds ?? item.person_ids)
      ? item.personIds ?? item.person_ids
      : [];
    const unique = Array.from(
      new Set(
        personIds
          .map((id) => Number(id))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    );
    for (const personId of unique) {
      pairs.push({ personId, floorIndex });
    }
  }

  if (pairs.length > 0) {
    const personIds = Array.from(new Set(pairs.map((p) => p.personId)));
    const rows = await db.query(
      `SELECT id, employee_no, full_name, config FROM persons WHERE id IN (${personIds.map(() => "?").join(",")}) AND status = 'active'`,
      personIds,
    );
    const existing = new Set((rows || []).map((r) => Number(r.id)));
    const missing = personIds.filter((id) => !existing.has(id));
    if (missing.length > 0) {
      const labels = await formatMissingPersonIdLabels(missing);
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `人員不存在或已停用：${labels.join("、")}`,
      );
    }

    const missingCardPersons = (rows || []).filter(
      (row) =>
        !String(personLadderCardService.resolveSyncFields(row, []).cardNo || "").trim(),
    );
    if (missingCardPersons.length > 0) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `以下人員未設定卡號，無法加入樓層授權：${missingCardPersons.map(formatPersonLabel).join("、")}（請於人員主檔卡片設定填寫）`,
      );
    }
  }

  await db.transaction(async (query) => {
    await query(
      `DELETE FROM person_elevator_floor_access WHERE location_id = ?`,
      [Number(locationId)],
    );
    if (pairs.length > 0) {
      const valuesSql = pairs.map(() => "(?, ?, ?)").join(", ");
      const params = pairs.flatMap((p) => [
        Number(locationId),
        p.personId,
        p.floorIndex,
      ]);
      await query(
        `INSERT INTO person_elevator_floor_access (location_id, person_id, floor_index) VALUES ${valuesSql}`,
        params,
      );
    }
  });

  await syncLadderFloorsFromLocationAssignments(Number(locationId), list);

  const floorAccess = await getFloorAccess(locationId);
  let deviceSync = null;
  try {
    const elevatorFloorSyncJobService = require("./elevatorFloorSyncJobService");
    const started = await elevatorFloorSyncJobService.startLocationSyncJob(
      Number(locationId),
      null,
    );
    if (started?.jobId) {
      deviceSync = { triggered: true, jobId: started.jobId };
    }
  } catch (err) {
    const logger = require("../../utils/logger").createLogger("ElevatorFloorAccess");
    logger.error("梯控背景同步啟動失敗", {
      locationId,
      message: err?.message || String(err),
    });
  }

  return { ...floorAccess, deviceSync };
}

async function syncPersonFloorAccessFromLadderFloors(personId, floorsStorage) {
  const pid = Number(personId);
  if (!Number.isFinite(pid) || pid <= 0) return;

  const byLocation =
    floorsStorage?.byLocation && typeof floorsStorage.byLocation === "object"
      ? floorsStorage.byLocation
      : {};
  const targetIds = new Set(
    Object.entries(byLocation)
      .filter(([, floors]) => parseFloorsJson(floors).length > 0)
      .map(([id]) => Number(id))
      .filter((n) => Number.isFinite(n) && n > 0),
  );

  const existingRows = await db.query(
    `SELECT DISTINCT location_id
     FROM person_elevator_floor_access
     WHERE person_id = ?`,
    [pid],
  );
  const locationIds = new Set([
    ...targetIds,
    ...(existingRows || [])
      .map((r) => Number(r.location_id))
      .filter((n) => Number.isFinite(n) && n > 0),
  ]);

  await db.transaction(async (query) => {
    for (const locationId of locationIds) {
      const floors = parseFloorsForLocation(floorsStorage, locationId);
      await query(
        `DELETE FROM person_elevator_floor_access
         WHERE location_id = ? AND person_id = ?`,
        [locationId, pid],
      );
      if (!floors.length) continue;
      const valuesSql = floors.map(() => "(?, ?, ?)").join(", ");
      const params = floors.flatMap((floorIndex) => [locationId, pid, floorIndex]);
      await query(
        `INSERT INTO person_elevator_floor_access (location_id, person_id, floor_index) VALUES ${valuesSql}`,
        params,
      );
    }
  });
}

async function syncLadderFloorsFromLocationAssignments(locationId, assignments = []) {
  const locId = Number(locationId);
  if (!Number.isFinite(locId) || locId <= 0) return;

  const personFloorMap = new Map();
  for (const item of assignments || []) {
    const floorIndex = Number(item.floorIndex ?? item.floor_index);
    if (!Number.isFinite(floorIndex) || floorIndex < 1) continue;
    const personIds = Array.isArray(item.personIds ?? item.person_ids)
      ? item.personIds ?? item.person_ids
      : [];
    for (const rawId of personIds) {
      const personId = Number(rawId);
      if (!Number.isFinite(personId) || personId <= 0) continue;
      if (!personFloorMap.has(personId)) personFloorMap.set(personId, new Set());
      personFloorMap.get(personId).add(floorIndex);
    }
  }

  const affectedIds = new Set(personFloorMap.keys());
  const hadRows = await db.query(
    `SELECT DISTINCT person_id
     FROM person_elevator_floor_access
     WHERE location_id = ?`,
    [locId],
  );
  for (const row of hadRows || []) {
    const personId = Number(row.person_id);
    if (Number.isFinite(personId) && personId > 0) affectedIds.add(personId);
  }
  if (!affectedIds.size) return;

  const cards = await db.query(
    `SELECT person_id, floors
     FROM person_ladder_cards
     WHERE person_id IN (${[...affectedIds].map(() => "?").join(",")})`,
    [...affectedIds],
  );
  const locKey = String(locId);

  for (const card of cards || []) {
    const personId = Number(card.person_id);
    if (!Number.isFinite(personId) || personId <= 0) continue;

    const hadAtLocation =
      parseFloorsForLocation(card.floors, locId).length > 0;
    const hasNew = personFloorMap.has(personId);
    if (!hadAtLocation && !hasNew) continue;

    let storage = card.floors;
    if (typeof storage === "string") {
      try {
        storage = JSON.parse(storage);
      } catch {
        storage = {};
      }
    }
    const byLocation =
      storage && typeof storage === "object" && !Array.isArray(storage)
        ? { ...(storage.byLocation || {}) }
        : Array.isArray(storage) && storage.length
          ? { [locKey]: parseFloorsJson(storage) }
          : {};

    if (hasNew) {
      byLocation[locKey] = [...personFloorMap.get(personId)].sort((a, b) => a - b);
    } else {
      delete byLocation[locKey];
    }

    const nextFloors =
      Object.keys(byLocation).length > 0 ? { byLocation } : { byLocation: {} };

    await db.query(
      `UPDATE person_ladder_cards
       SET floors = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE person_id = ?`,
      [JSON.stringify(nextFloors), personId],
    );
  }
}

async function getPersonIdsWithFloorAccess(locationId) {
  const rows = await db.query(
    `SELECT DISTINCT person_id
     FROM person_elevator_floor_access
     WHERE location_id = ?`,
    [Number(locationId)],
  );
  return (rows || [])
    .map((r) => Number(r.person_id))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function aggregateFloorsForPerson(locationId, personId) {
  const rows = await db.query(
    `SELECT floor_index
     FROM person_elevator_floor_access
     WHERE location_id = ? AND person_id = ?
     ORDER BY floor_index ASC`,
    [Number(locationId), Number(personId)],
  );
  return (rows || [])
    .map((r) => Number(r.floor_index))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function getPersonsWithFloorAccess(locationId) {
  const rows = await db.query(
    `SELECT DISTINCT p.id, p.employee_no, p.full_name, p.status, p.person_group_id,
            p.face_url, p.config, pg.name AS group_name
     FROM person_elevator_floor_access pefa
     INNER JOIN persons p ON p.id = pefa.person_id
     LEFT JOIN person_groups pg ON p.person_group_id = pg.id
     WHERE pefa.location_id = ? AND p.status = 'active'
     ORDER BY p.employee_no ASC`,
    [Number(locationId)],
  );
  return rows || [];
}

module.exports = {
  getFloorAccess,
  replaceFloorAccess,
  syncPersonFloorAccessFromLadderFloors,
  getPersonIdsWithFloorAccess,
  aggregateFloorsForPerson,
  getPersonsWithFloorAccess,
  getActivePersonsWithLadderFloors,
};
