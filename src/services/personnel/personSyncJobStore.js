const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const ITEM_TYPES = new Set(["issues", "tail"]);
const JOB_TYPES = new Set([
  "sync_location",
  "sync_all_locations",
  "elevator_sync_location",
  "person_sync",
]);
const JOB_STATUSES = new Set(["queued", "running", "completed"]);

const MAX_JOB_ISSUES_ITEMS = 2000;
const MAX_JOB_TAIL_ITEMS = 200;

const asJson = (v) => (v == null ? null : JSON.stringify(v));

const assertIn = (set, v, label) => {
  const s = String(v || "");
  if (!set.has(s)) {
    throwApiError(C.PERSONNEL_SYNC_JOB_INVALID_REQUEST, `${label} 不合法: ${s}`);
  }
  return s;
};

const toJobRow = (r) => {
  if (!r) return null;
  return {
    jobId: r.job_id,
    jobType: r.job_type,
    locationId: r.location_id != null ? Number(r.location_id) : null,
    status: r.status,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
    startedAt: r.started_at ? new Date(r.started_at).getTime() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null,
    progress: r.progress || {},
    itemsMeta: r.items_meta || {},
    result: r.result || null,
    error: r.error || null,
  };
};

const nowIso = () => new Date().toISOString();

async function createJob(params) {
  const jobId = String(params?.jobId || "").trim();
  if (!jobId) throwApiError(C.PERSONNEL_SYNC_JOB_INVALID_REQUEST,"jobId 必填");
  const jobType = assertIn(JOB_TYPES, params?.jobType, "jobType");
  const status = assertIn(JOB_STATUSES, params?.status || "queued", "status");
  const locationId =
    params?.locationId != null && Number.isFinite(Number(params.locationId))
      ? Math.trunc(Number(params.locationId))
      : null;

  const progress = params?.progress && typeof params.progress === "object" ? params.progress : {};
  const itemsMeta = params?.itemsMeta && typeof params.itemsMeta === "object" ? params.itemsMeta : {};

  const [created] = await db.query(
    `INSERT INTO person_sync_jobs (
       job_id, job_type, location_id, status,
       progress, items_meta,
       created_at
     ) VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::timestamptz)
     ON CONFLICT (job_id) DO NOTHING
     RETURNING *`,
    [jobId, jobType, locationId, status, JSON.stringify(progress), JSON.stringify(itemsMeta), nowIso()],
  );

  return created ? toJobRow(created) : getJob(jobId);
}

async function updateJob(jobId, patch) {
  const id = String(jobId || "").trim();
  if (!id) throwApiError(C.PERSONNEL_SYNC_JOB_INVALID_REQUEST,"jobId 必填");

  const sets = [];
  const args = [];

  const set = (sql, value) => {
    sets.push(sql);
    args.push(value);
  };

  if (patch?.status != null) {
    const status = assertIn(JOB_STATUSES, patch.status, "status");
    set("status = ?", status);
  }
  if (patch?.locationId !== undefined) {
    const locationId =
      patch.locationId != null && Number.isFinite(Number(patch.locationId))
        ? Math.trunc(Number(patch.locationId))
        : null;
    set("location_id = ?", locationId);
  }
  if (patch?.startedAt !== undefined) {
    const iso = patch.startedAt != null ? new Date(Number(patch.startedAt)).toISOString() : null;
    set("started_at = ?::timestamptz", iso);
  }
  if (patch?.finishedAt !== undefined) {
    const iso = patch.finishedAt != null ? new Date(Number(patch.finishedAt)).toISOString() : null;
    set("finished_at = ?::timestamptz", iso);
  }
  if (patch?.progress !== undefined) set("progress = ?::jsonb", asJson(patch.progress || {}));
  if (patch?.itemsMeta !== undefined) set("items_meta = ?::jsonb", asJson(patch.itemsMeta || {}));
  if (patch?.result !== undefined) set("result = ?::jsonb", asJson(patch.result));
  if (patch?.error !== undefined) set("error = ?::jsonb", asJson(patch.error));

  if (sets.length === 0) return await getJob(id);

  args.push(id);
  const [updated] = await db.query(
    `UPDATE person_sync_jobs SET ${sets.join(", ")} WHERE job_id = ? RETURNING *`,
    args,
  );
  return toJobRow(updated);
}

async function getJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const rows = await db.query(`SELECT * FROM person_sync_jobs WHERE job_id = ?`, [id]);
  return toJobRow(rows?.[0] || null);
}

/**
 * 同 jobType + location_id 的進行中 job（single-flight 用）
 * @param {string} jobType
 * @param {number} locationId
 * @returns {Promise<string|null>} jobId
 */
async function findRunningJobByTypeAndLocation(jobType, locationId) {
  const type = String(jobType || "").trim();
  const locId = Number(locationId);
  if (!JOB_TYPES.has(type) || !Number.isFinite(locId) || locId <= 0) return null;
  const rows = await db.query(
    `
      SELECT job_id
      FROM person_sync_jobs
      WHERE status IN ('queued', 'running')
        AND job_type = ?
        AND location_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [type, Math.trunc(locId)],
  );
  return rows?.[0]?.job_id || null;
}

async function bumpItemsMetaCounter(jobId, key, n = 1) {
  const id = String(jobId || "").trim();
  if (!id) return;
  const k = String(key || "").trim();
  if (!k) return;
  const inc = Number(n) || 0;
  await db.query(
    `UPDATE person_sync_jobs
     SET items_meta = jsonb_set(
       COALESCE(items_meta, '{}'::jsonb),
       ARRAY[?]::text[],
       to_jsonb(COALESCE((items_meta->>?)::int, 0) + ?),
       true
     )
     WHERE job_id = ?`,
    [k, k, inc, id],
  );
}

async function appendItem(jobId, itemType, payload) {
  const id = String(jobId || "").trim();
  if (!id) throwApiError(C.PERSONNEL_SYNC_JOB_INVALID_REQUEST,"jobId 必填");
  const type = assertIn(ITEM_TYPES, itemType, "itemType");
  if (!payload || typeof payload !== "object") throwApiError(C.PERSONNEL_SYNC_JOB_INVALID_REQUEST,"payload 必須為 object");

  await db.query(
    `INSERT INTO person_sync_job_items (job_id, item_type, payload)
     VALUES (?, ?, ?::jsonb)`,
    [id, type, JSON.stringify(payload)],
  );

  // counters：tailTotal / issuesTotal（累積總發生筆數）
  await bumpItemsMetaCounter(id, type === "tail" ? "tailTotal" : "issuesTotal");

  // ring buffer：只保留最後 N 筆
  const keep = type === "tail" ? MAX_JOB_TAIL_ITEMS : MAX_JOB_ISSUES_ITEMS;

  await db.query(
    `DELETE FROM person_sync_job_items
     WHERE id IN (
       SELECT id
       FROM person_sync_job_items
       WHERE job_id = ? AND item_type = ?
       ORDER BY id DESC
       OFFSET ?
     )`,
    [id, type, keep],
  );
}

async function listItems(jobId, itemType, params = {}) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const type = assertIn(ITEM_TYPES, itemType, "itemType");
  const limit = Math.max(1, Math.min(1000, Math.trunc(Number(params.limit) || 200)));
  const offset = Math.max(0, Math.trunc(Number(params.offset) || 0));

  const totalRows = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM person_sync_job_items
     WHERE job_id = ? AND item_type = ?`,
    [id, type],
  );
  const total = Number(totalRows?.[0]?.total) || 0;

  const rows = await db.query(
    `SELECT id, payload, created_at
     FROM person_sync_job_items
     WHERE job_id = ? AND item_type = ?
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [id, type, limit, offset],
  );

  const items = (rows || []).map((r) => r.payload);
  return { type, items, total, limit, offset };
}

async function replaceWarnings(jobId, warnings, locationId = null) {
  const id = String(jobId || "").trim();
  if (!id) throwApiError(C.PERSONNEL_SYNC_JOB_INVALID_REQUEST,"jobId 必填");
  const loc =
    locationId != null && Number.isFinite(Number(locationId)) ? Math.trunc(Number(locationId)) : null;

  const list = Array.isArray(warnings)
    ? warnings.filter((warning) => warning && typeof warning === "object")
    : [];
  await db.transaction(async (query) => {
    await query(`DELETE FROM person_sync_job_warnings WHERE job_id = ?`, [id]);
    if (list.length === 0) return;
    await query(
      `INSERT INTO person_sync_job_warnings (job_id, location_id, payload)
       SELECT ?, ?, warning.payload
       FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS warning(payload, position)
       ORDER BY warning.position`,
      [id, loc, JSON.stringify(list)],
    );
  });
}

async function listWarnings(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return [];
  const rows = await db.query(
    `SELECT payload
     FROM person_sync_job_warnings
     WHERE job_id = ?
     ORDER BY id ASC`,
    [id],
  );
  return (rows || []).map((r) => r.payload).filter(Boolean);
}

module.exports = {
  createJob,
  updateJob,
  getJob,
  findRunningJobByTypeAndLocation,

  appendItem,
  listItems,

  replaceWarnings,
  listWarnings,
};

