/**
 * 人員授權編排層：一人授權總覽、增量地點授權、觸發 person_sync
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const locationMemberService = require("./locationMemberService");
const personLadderCardService = require("./personLadderCardService");
const personLicensePlateService = require("./personLicensePlateService");
const { resolveCardNos } = require("../../utils/accessControlCardsUtils");
const logger = require("../../utils/logger").createLogger(
  "PersonEntitlementService",
);

const parseConfig = (raw) => {
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

const toPositiveIds = (list) =>
  [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((x) => Number.parseInt(String(x), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n)),
    ),
  ];

async function ensurePersonRow(personId) {
  const pid = Number(personId);
  if (!Number.isFinite(pid) || pid <= 0) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "無效的人員 ID");
  }
  const rows = await db.query(
    `SELECT id, employee_no, full_name, status, face_url, config
     FROM active_persons WHERE id = ? LIMIT 1`,
    [pid],
  );
  if (!rows?.[0]) {
    throwApiError(C.PERSONNEL_PERSON_NOT_FOUND, "人員不存在", {
      statusCode: 404,
    });
  }
  return rows[0];
}

function buildCredentialsSummary(personRow, plateCount) {
  const ac = parseConfig(personRow.config)?.access_control || {};
  const cards = resolveCardNos(ac);
  const fingerprintCount = Array.isArray(ac.fingerprints)
    ? ac.fingerprints.length
    : 0;
  return {
    hasFace: Boolean(personRow.face_url && String(personRow.face_url).trim()),
    hasCard: cards.length > 0,
    cardCount: cards.length,
    fingerprintCount: Number(fingerprintCount) || 0,
    plateCount: Number(plateCount) || 0,
  };
}

async function listCandidateAccessLocations() {
  const rows = await db.query(
    `
      SELECT
        l.id AS location_id,
        l.name AS location_name,
        z.id AS zone_id,
        z.name AS zone_name,
        ls.system_type,
        ls.system_config
      FROM active_locations l
      INNER JOIN active_zones z ON z.id = l.zone_id
      INNER JOIN active_location_systems ls ON ls.location_id = l.id
      WHERE ls.system_type IN ('people_counting', 'roll_call', 'vehicle_access')
      ORDER BY z.name, l.name, ls.system_type
    `,
  );
  const byId = new Map();
  for (const row of rows || []) {
    const locationId = Number(row.location_id);
    if (!Number.isFinite(locationId)) continue;
    let entry = byId.get(locationId);
    if (!entry) {
      entry = {
        locationId,
        locationName: row.location_name,
        zoneId: row.zone_id != null ? Number(row.zone_id) : null,
        zoneName: row.zone_name || null,
        flags: {
          peopleCounting: false,
          rollCall: false,
          vehiclePlates: false,
        },
        granted: false,
      };
      byId.set(locationId, entry);
    }
    const cfg =
      typeof row.system_config === "string"
        ? (() => {
            try {
              return JSON.parse(row.system_config);
            } catch {
              return {};
            }
          })()
        : row.system_config || {};
    if (
      row.system_type === "people_counting" &&
      locationMemberService.isPeopleCountingSyncableConfig(cfg)
    ) {
      entry.flags.peopleCounting = true;
    }
    if (
      row.system_type === "roll_call" &&
      locationMemberService.isRollCallSyncableConfig(cfg)
    ) {
      entry.flags.rollCall = true;
    }
    if (
      row.system_type === "vehicle_access" &&
      cfg.data_source === "isapi_camera"
    ) {
      const entryCam = Array.isArray(cfg.entry_camera_device_ids)
        ? cfg.entry_camera_device_ids
        : [];
      const exitCam = Array.isArray(cfg.exit_camera_device_ids)
        ? cfg.exit_camera_device_ids
        : [];
      if (entryCam.length > 0 || exitCam.length > 0) {
        entry.flags.vehiclePlates = true;
      }
    }
  }
  return [...byId.values()].filter(
    (e) =>
      e.flags.peopleCounting || e.flags.rollCall || e.flags.vehiclePlates,
  );
}

async function listElevatorEntitlements(personId) {
  const rows = await db.query(
    `
      SELECT
        l.id AS location_id,
        l.name AS location_name,
        z.name AS zone_name,
        array_agg(pefa.floor_index ORDER BY pefa.floor_index) AS floor_indexes
      FROM person_elevator_floor_access pefa
      INNER JOIN active_locations l ON l.id = pefa.location_id
      INNER JOIN active_zones z ON z.id = l.zone_id
      INNER JOIN active_location_systems ls
        ON ls.location_id = l.id AND ls.system_type = 'elevator'
      WHERE pefa.person_id = ?
      GROUP BY l.id, l.name, z.name
      ORDER BY z.name, l.name
    `,
    [Number(personId)],
  );

  const ladder = await personLadderCardService.getByPersonId(personId);
  return (rows || []).map((r) => ({
    locationId: Number(r.location_id),
    locationName: r.location_name,
    zoneName: r.zone_name,
    floorIndexes: Array.isArray(r.floor_indexes)
      ? r.floor_indexes.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [],
    ladderSyncStatus: ladder?.sdk_sync_status || null,
    ladderSyncError: ladder?.sdk_sync_error || null,
  }));
}

async function listActivePersonJobs(personId) {
  const pid = String(Math.trunc(Number(personId)));
  const rows = await db.query(
    `
      SELECT job_id, job_type, status, location_id, progress, created_at, started_at
      FROM person_sync_jobs
      WHERE status IN ('queued', 'running')
        AND (
          job_type = 'person_sync' AND progress->>'personId' = ?
        )
      ORDER BY created_at DESC
      LIMIT 20
    `,
    [pid],
  );
  return (rows || []).map((r) => ({
    jobId: r.job_id,
    jobType: r.job_type,
    status: r.status,
    locationId: r.location_id != null ? Number(r.location_id) : null,
    progress: r.progress || {},
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
    startedAt: r.started_at ? new Date(r.started_at).getTime() : null,
  }));
}

async function getPersonEntitlements(personId) {
  const person = await ensurePersonRow(personId);
  const plates = await personLicensePlateService.listByPersonId(person.id);
  const candidates = await listCandidateAccessLocations();
  const grantedRows = await db.query(
    `SELECT location_id FROM person_location_access WHERE person_id = ?`,
    [person.id],
  );
  const grantedSet = new Set(
    (grantedRows || [])
      .map((r) => Number(r.location_id))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
  for (const loc of candidates) {
    loc.granted = grantedSet.has(loc.locationId);
  }

  const elevator = await listElevatorEntitlements(person.id);
  const activeJobs = await listActivePersonJobs(person.id);

  return {
    personId: Number(person.id),
    employeeNo: person.employee_no,
    fullName: person.full_name,
    status: person.status,
    credentials: buildCredentialsSummary(person, plates.length),
    locations: candidates,
    elevator,
    activeJobs,
  };
}

/**
 * 呼叫者需已通過各變更地點的 members 子權限檢查
 */
async function patchPersonLocationAccess(personId, body = {}) {
  const person = await ensurePersonRow(personId);
  const grantLocationIds = toPositiveIds(body.grantLocationIds);
  const revokeLocationIds = toPositiveIds(body.revokeLocationIds);
  const sync = body.sync !== false;

  const result = await locationMemberService.patchPersonLocationAccess(
    person.id,
    { grantLocationIds, revokeLocationIds },
  );

  let deviceSync = { triggered: false, jobId: null };
  if (sync && (result.granted.length || result.revoked.length)) {
    try {
      const personScopedSyncJobService = require("./personScopedSyncJobService");
      const started = await personScopedSyncJobService.startPersonSyncJob(
        person.id,
        {
          locationIds: result.locationIdsTouched,
          domains: ["access", "plates"],
          revokeLocationIds: result.revoked,
          grantLocationIds: result.granted,
        },
      );
      deviceSync = { triggered: true, jobId: started.jobId };
    } catch (err) {
      logger.warn("增量授權後觸發 person_sync 失敗", {
        personId: person.id,
        message: err?.message || String(err),
      });
      deviceSync = { triggered: false, jobId: null, error: err?.message || String(err) };
    }
  }

  return {
    personId: Number(person.id),
    granted: result.granted,
    revoked: result.revoked,
    deviceSync,
  };
}

async function listElevatorCandidateLocations() {
  const rows = await db.query(
    `
      SELECT l.id AS location_id, l.name AS location_name, z.name AS zone_name,
             ls.system_config
      FROM active_locations l
      INNER JOIN active_zones z ON z.id = l.zone_id
      INNER JOIN active_location_systems ls
        ON ls.location_id = l.id AND ls.system_type = 'elevator'
      ORDER BY z.name, l.name
    `,
  );
  return (rows || []).map((r) => {
    const cfg =
      typeof r.system_config === "string"
        ? (() => {
            try {
              return JSON.parse(r.system_config);
            } catch {
              return {};
            }
          })()
        : r.system_config || {};
    const floors = Array.isArray(cfg.floors) ? cfg.floors : [];
    return {
      locationId: Number(r.location_id),
      locationName: r.location_name,
      zoneName: r.zone_name,
      floors: floors.map((f, idx) => ({
        floorIndex: idx + 1,
        code: f?.code ?? f?.name ?? String(idx + 1),
        name: f?.name ?? f?.code ?? `F${idx + 1}`,
      })),
    };
  });
}

module.exports = {
  getPersonEntitlements,
  patchPersonLocationAccess,
  listElevatorCandidateLocations,
};
