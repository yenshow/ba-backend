/**
 * 設備同步雙管線排隊：person_sync ↔ sync_location／elevator_sync_location
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toPositiveIds = (arr) =>
  [
    ...new Set(
      (Array.isArray(arr) ? arr : [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n)),
    ),
  ];

const listHasLocation = (list, locId) =>
  Array.isArray(list) && list.some((id) => Number(id) === locId);

const progressLocationLists = (p) => [
  p.grantLocationIds,
  p.revokeLocationIds,
  p.locationIds,
  p.touchLocationIds,
];

const hasScopedLocationIds = (p) =>
  progressLocationLists(p).some((list) => Array.isArray(list) && list.length > 0) ||
  (p.currentLocationId != null && Number(p.currentLocationId) > 0);

/**
 * @param {() => Promise<boolean>} hasConflict
 * @param {string} message
 * @param {number} timeoutMs
 */
async function waitWhileConflict(hasConflict, message, timeoutMs) {
  const started = Date.now();
  for (;;) {
    if (!(await hasConflict())) return;
    if (Date.now() - started > timeoutMs) {
      throwApiError(C.PERSONNEL_SYNC_JOB_INVALID_REQUEST, message, {
        statusCode: 409,
      });
    }
    const remain = timeoutMs - (Date.now() - started);
    await sleep(Math.max(50, Math.min(POLL_MS, remain)));
  }
}

/**
 * person_sync 啟動前：等待同地點的 sync_location／elevator_sync_location
 * @param {number[]} locationIds
 * @param {{ timeoutMs?: number }} [opts]
 */
async function waitForConflictingLocationJobs(
  locationIds,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const ids = toPositiveIds(locationIds);
  if (!ids.length) return;
  await waitWhileConflict(
    async () => {
      const rows = await db.query(
        `
          SELECT job_id
          FROM person_sync_jobs
          WHERE status IN ('queued', 'running')
            AND job_type IN ('sync_location', 'elevator_sync_location')
            AND location_id = ANY(?::int[])
          LIMIT 1
        `,
        [ids],
      );
      return Boolean(rows?.length);
    },
    "地點同步進行中，請稍後再同步此人",
    timeoutMs,
  );
}

/**
 * 判斷 progress 是否「碰」到指定地點
 * @param {object} progress
 * @param {number} locationId
 */
function progressTouchesLocation(progress, locationId) {
  const locId = Math.trunc(Number(locationId));
  if (!Number.isFinite(locId) || locId <= 0) return false;
  const p = progress && typeof progress === "object" ? progress : {};
  if (Number(p.currentLocationId) === locId) return true;
  return progressLocationLists(p).some((list) => listHasLocation(list, locId));
}

/**
 * 無明確 scoped ids 時：以人員授權／電梯樓層判斷是否碰此地點
 * @param {number} personId
 * @param {number} locationId
 */
async function personHasTouchAtLocation(personId, locationId) {
  const pid = Number(personId);
  const locId = Number(locationId);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(locId) || locId <= 0) {
    return false;
  }
  const rows = await db.query(
    `
      SELECT (
        EXISTS (
          SELECT 1 FROM person_location_access
          WHERE person_id = ? AND location_id = ?
        )
        OR EXISTS (
          SELECT 1 FROM person_elevator_floor_access
          WHERE person_id = ? AND location_id = ?
        )
      ) AS ok
    `,
    [pid, locId, pid, locId],
  );
  return Boolean(rows?.[0]?.ok);
}

/**
 * 地點 sync／車牌觸發前：等待碰此地點的進行中 person_sync
 * @param {number} locationId
 * @param {{ timeoutMs?: number }} [opts]
 */
async function waitForConflictingPersonSyncJobs(
  locationId,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const locId = Math.trunc(Number(locationId));
  if (!Number.isFinite(locId) || locId <= 0) return;

  await waitWhileConflict(
    async () => {
      const rows = await db.query(
        `
          SELECT progress
          FROM person_sync_jobs
          WHERE status IN ('queued', 'running')
            AND job_type = 'person_sync'
          ORDER BY created_at ASC
          LIMIT 20
        `,
      );
      for (const row of rows || []) {
        const progress = row.progress || {};
        if (progressTouchesLocation(progress, locId)) return true;
        const personId = Number(progress.personId);
        if (
          !hasScopedLocationIds(progress) &&
          Number.isFinite(personId) &&
          personId > 0 &&
          (await personHasTouchAtLocation(personId, locId))
        ) {
          return true;
        }
      }
      return false;
    },
    "人員同步進行中，請稍後再同步此地點",
    timeoutMs,
  );
}

module.exports = {
  sleep,
  toPositiveIds,
  waitForConflictingLocationJobs,
  waitForConflictingPersonSyncJobs,
  progressTouchesLocation,
};
