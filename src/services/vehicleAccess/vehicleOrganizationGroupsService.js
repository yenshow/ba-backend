/**
 * ISAPI 車輛地點：依 person_location_access + person_group 動態組織群組
 */
const db = require("../../database/db");
const personnelService = require("../personnel/personnelService");
const { computeTransitionStats } = require("../entryExit/stats");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { resolveStatsTimeRange } = require("../entryExit/resolveTimeOptions");
const { normalizeVehicleDirection } = require("./vehicleAccessHelpers");

const UNGROUPED_GROUP_ID = 0;
const UNGROUPED_GROUP_NAME = "未分組";

function groupPersonsByPersonGroup(persons) {
  const byGroupId = new Map();
  for (const p of persons || []) {
    const groupId =
      p.person_group_id != null && Number.isFinite(Number(p.person_group_id))
        ? Number(p.person_group_id)
        : UNGROUPED_GROUP_ID;
    const groupName =
      groupId === UNGROUPED_GROUP_ID
        ? UNGROUPED_GROUP_NAME
        : p.group_name || UNGROUPED_GROUP_NAME;
    if (!byGroupId.has(groupId)) {
      byGroupId.set(groupId, { id: groupId, name: groupName, list: [] });
    }
    byGroupId.get(groupId).list.push(p);
  }
  return [...byGroupId.values()].sort((a, b) => {
    if (a.id === UNGROUPED_GROUP_ID) return 1;
    if (b.id === UNGROUPED_GROUP_ID) return -1;
    return String(a.name).localeCompare(String(b.name), "zh-Hant");
  });
}

function statsFromVehicleLogs(logs) {
  return computeTransitionStats(logs || [], {
    getKey: (log) => normalizePlate(log.license_plate || log.licensePlate),
    getDirection: (log) =>
      normalizeVehicleDirection({
        allow_result: 1,
        lane_type: log.lane_type ?? log.laneType,
      }),
    getTime: (log) => log.trigger_time ?? log.triggerTime,
  });
}

function collectPlatesForPerson(person, platesByPersonId) {
  return platesByPersonId.get(Number(person.id)) || [];
}

async function buildOrganizationGroups(siteId, { logs = [], presentPlates } = {}) {
  const persons = await personnelService.getPersonsWithAccessByLocationId(siteId);
  const grouped = groupPersonsByPersonGroup(persons);
  const personIds = persons.map((p) => Number(p.id)).filter((n) => Number.isFinite(n));
  const platesByPersonId = new Map();
  if (personIds.length > 0) {
    const placeholders = personIds.map(() => "?").join(",");
    const plateRows = await db.query(
      `
        SELECT person_id, plate_number
        FROM person_license_plates
        WHERE person_id IN (${placeholders})
        ORDER BY id ASC
      `,
      personIds,
    );
    for (const row of plateRows || []) {
      const pid = Number(row.person_id);
      const plate = String(row.plate_number || "").trim();
      if (!Number.isFinite(pid) || !plate) continue;
      if (!platesByPersonId.has(pid)) platesByPersonId.set(pid, []);
      platesByPersonId.get(pid).push(plate);
    }
  }

  /** 呼叫端明確傳入 presentPlates（含空陣列）時以 presence 為準，避免停車場 Reset 後誤用當日 logs */
  const usePresentPlates =
    presentPlates instanceof Set || Array.isArray(presentPlates);
  const presentSet = usePresentPlates
    ? presentPlates instanceof Set
      ? presentPlates
      : new Set(
          presentPlates.map((p) => normalizePlate(p)).filter(Boolean),
        )
    : null;

  const validLogs = (logs || []).filter(
    (log) => log.release_result === "released" || log.release_result == null,
  );

  return grouped.map((group) => {
    const members = group.list.map((person) => {
      const plates = collectPlatesForPerson(person, platesByPersonId);
      const plateNorms = new Set(plates.map((p) => normalizePlate(p)).filter(Boolean));
      const personLogs = validLogs.filter((log) =>
        plateNorms.has(normalizePlate(log.license_plate || log.licensePlate)),
      );
      const stats = statsFromVehicleLogs(personLogs);
      const isPresent = usePresentPlates
        ? plates.some((p) => presentSet.has(normalizePlate(p)))
        : stats.currentCount > 0;
      return {
        id: person.id,
        name: person.full_name || person.employee_no || "—",
        employeeNo: String(person.employee_no || ""),
        photoUrl: person.face_url || null,
        plates,
        isPresent,
        lastEntryDate: null,
        entryTime: null,
        exitTime: null,
      };
    });

    const onSiteCount = members.filter((m) => m.isPresent).length;
    return {
      groupKey: `pg_${group.id}`,
      personGroupId: group.id,
      personGroupName: group.name,
      vehicleCount: group.list.length,
      onSiteCount,
      entryCount: 0,
      exitCount: 0,
      members,
    };
  });
}

async function getOrganizationGroupsForSite(siteId, options = {}) {
  const locationId = Number(siteId);
  if (!Number.isFinite(locationId)) return { groups: [] };

  let logs = Array.isArray(options.logs) ? options.logs : null;
  if (!logs) {
    const { start, end } = resolveStatsTimeRange({});
    const rows = await db.query(
      `SELECT license_plate, allow_result, lane_type, trigger_time
       FROM vehicle_passageway_logs
       WHERE location_id = ? AND data_source = 'isapi_camera'
         AND trigger_time >= ? AND trigger_time <= ?
         AND allow_result = 1 AND lane_type IN (1, 2)
       ORDER BY trigger_time ASC`,
      [locationId, start.toISOString(), end.toISOString()],
    );
    logs = (rows || []).map((row) => ({
      license_plate: row.license_plate,
      lane_type: row.lane_type,
      trigger_time:
        row.trigger_time instanceof Date
          ? row.trigger_time.toISOString()
          : row.trigger_time,
      release_result: "released",
    }));
  }

  const groups = await buildOrganizationGroups(locationId, {
    ...options,
    logs,
  });
  return { groups };
}

module.exports = {
  getOrganizationGroupsForSite,
  buildOrganizationGroups,
  groupPersonsByPersonGroup,
};
