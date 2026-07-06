/**
 * 地點可進出人員名單（person_location_access）SSOT
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { formatMissingPersonIdLabels } = require("../../utils/personDisplayUtils");
const logger = require("../../utils/logger").createLogger("LocationMemberService");

function parseSystemConfig(raw) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw || {};
}

async function getLocationSystemSyncFlags(locationId) {
  const rows = await db.query(
    `
      SELECT system_type, system_config
      FROM location_systems
      WHERE location_id = ?
    `,
    [locationId],
  );
  let peopleCounting = false;
  let vehiclePlates = false;
  for (const row of rows || []) {
    const cfg = parseSystemConfig(row.system_config);
    if (row.system_type === "people_counting") {
      const entryIds = Array.isArray(cfg.entry_device_ids) ? cfg.entry_device_ids : [];
      if (entryIds.length > 0) peopleCounting = true;
    }
    if (row.system_type === "vehicle_access" && cfg.data_source === "isapi_camera") {
      const entryCam = Array.isArray(cfg.entry_camera_device_ids)
        ? cfg.entry_camera_device_ids
        : [];
      const exitCam = Array.isArray(cfg.exit_camera_device_ids)
        ? cfg.exit_camera_device_ids
        : [];
      if (entryCam.length > 0 || exitCam.length > 0) vehiclePlates = true;
    }
  }
  return { peopleCounting, vehiclePlates };
}

async function ensureLocationExists(locationId) {
  const id = Number.parseInt(String(locationId), 10);
  if (!Number.isFinite(id)) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "無效的地點 ID");
  }
  const rows = await db.query(`SELECT id FROM locations WHERE id = ? LIMIT 1`, [id]);
  if (!rows?.[0]) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "地點不存在");
  }
  return id;
}

/** 地點名單管理：人流門禁或 ISAPI 車輛地點 */
async function ensureLocationAllowsAccessMembers(locationId) {
  const id = await ensureLocationExists(locationId);
  const rows = await db.query(
    `
      SELECT ls.system_type, ls.system_config
      FROM location_systems ls
      WHERE ls.location_id = ?
    `,
    [id],
  );
  let allowed = false;
  for (const row of rows || []) {
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
    if (row.system_type === "people_counting") {
      const entryIds = Array.isArray(cfg.entry_device_ids)
        ? cfg.entry_device_ids
        : [];
      if (entryIds.length > 0) allowed = true;
    }
    if (row.system_type === "vehicle_access" && cfg.data_source === "isapi_camera") {
      const entryCam = Array.isArray(cfg.entry_camera_device_ids)
        ? cfg.entry_camera_device_ids
        : [];
      const exitCam = Array.isArray(cfg.exit_camera_device_ids)
        ? cfg.exit_camera_device_ids
        : [];
      if (entryCam.length > 0 || exitCam.length > 0) allowed = true;
    }
  }
  if (!allowed) {
    throwApiError(
      C.PERSONNEL_VALIDATION_FAILED,
      "此地點不支援名單管理（需設定人流門禁入口設備或 ISAPI 車輛攝影機）",
    );
  }
  return id;
}

function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function syncLicensePlatesForLocation(locationId) {
  const id = await ensureLocationAllowsAccessMembers(locationId);
  const vehiclePlateSyncService = require("../vehicleAccess/vehiclePlateSyncService");
  return vehiclePlateSyncService.syncPlatesForLocation(id);
}

/** 套用名單後背景同步（不阻擋名單寫入） */
function triggerVehiclePlateSyncForLocation(locationId) {
  void syncLicensePlatesForLocation(locationId).catch((err) => {
    logger.error("車牌背景同步失敗", {
      locationId,
      message: err?.message || String(err),
    });
  });
}

function triggerPeopleCountingSyncForLocation(locationId) {
  try {
    const personSyncJobService = require("./personSyncJobService");
    return personSyncJobService.startSyncLocationJob(locationId);
  } catch (err) {
    logger.error("人流門禁背景同步啟動失敗", {
      locationId,
      message: err?.message || String(err),
    });
    return null;
  }
}

async function triggerDeviceSyncAfterMemberApply(locationId) {
  const flags = await getLocationSystemSyncFlags(locationId);
  const meta = {};

  if (flags.peopleCounting) {
    const started = triggerPeopleCountingSyncForLocation(locationId);
    if (started?.jobId) {
      meta.deviceSync = { triggered: true, jobId: started.jobId };
    }
  }

  if (flags.vehiclePlates) {
    triggerVehiclePlateSyncForLocation(locationId);
    meta.plateSync = { triggered: true };
  }

  return meta;
}

async function getPersonIdsByLocationId(locationId) {
  const rows = await db.query(
    "SELECT person_id FROM person_location_access WHERE location_id = ?",
    [locationId],
  );
  return (rows || []).map((r) => r.person_id);
}

async function getPersonsByLocationIdPaged(locationId, options = {}) {
  const id = await ensureLocationAllowsAccessMembers(locationId);
  const limit = clampInt(options.limit, { min: 1, max: 500, fallback: 20 });
  const offset = clampInt(options.offset, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: 0,
  });
  const status = options.status ? String(options.status).trim() : "";
  const q = options.q != null ? String(options.q).trim() : "";

  const whereParts = ["pla.location_id = ?"];
  const params = [id];
  if (status) {
    params.push(status);
    whereParts.push("p.status = ?");
  }
  if (q) {
    params.push(`%${q}%`);
    params.push(`%${q}%`);
    whereParts.push("(p.employee_no ILIKE ? OR p.full_name ILIKE ?)");
  }

  const whereSql = `WHERE ${whereParts.join(" AND ")}`;

  const countRows = await db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM person_location_access pla
      INNER JOIN persons p ON pla.person_id = p.id
      ${whereSql}
    `,
    params,
  );
  const total = countRows?.[0]?.total ?? 0;

  const rows = await db.query(
    `
      SELECT p.*, pg.name AS group_name
      FROM person_location_access pla
      INNER JOIN persons p ON pla.person_id = p.id
      LEFT JOIN person_groups pg ON p.person_group_id = pg.id
      ${whereSql}
      ORDER BY p.employee_no ASC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );

  return { items: rows || [], total, limit, offset };
}

async function replaceLocationMembers(locationId, memberPersonIds = []) {
  const id = await ensureLocationAllowsAccessMembers(locationId);
  const previousIds = await getPersonIdsByLocationId(id);

  const rawIds = Array.isArray(memberPersonIds)
    ? memberPersonIds
        .map((x) => Number.parseInt(String(x), 10))
        .filter((x) => Number.isFinite(x))
    : [];
  const nextIds = Array.from(new Set(rawIds));

  if (nextIds.length > 0) {
    const rows = await db.query(
      `SELECT id FROM persons WHERE id IN (${nextIds.map(() => "?").join(",")})`,
      nextIds,
    );
    const existing = new Set((rows || []).map((r) => r.id));
    const missing = nextIds.filter((pid) => !existing.has(pid));
    if (missing.length > 0) {
      const labels = await formatMissingPersonIdLabels(missing);
      throwApiError(
        C.PERSONNEL_VALIDATION_FAILED,
        `人員不存在：${labels.join("、")}`,
      );
    }
  }

  await db.transaction(async (query) => {
    await query("DELETE FROM person_location_access WHERE location_id = ?", [id]);
    if (nextIds.length > 0) {
      const valuesSql = nextIds.map(() => "(?, ?)").join(", ");
      const params = nextIds.flatMap((pid) => [pid, id]);
      await query(
        `INSERT INTO person_location_access (person_id, location_id) VALUES ${valuesSql}`,
        params,
      );
    }
  });

  const removedPersonIds = (previousIds || []).filter((pid) => !nextIds.includes(pid));
  if (removedPersonIds.length > 0) {
    try {
      const vehiclePlateSyncService = require("../vehicleAccess/vehiclePlateSyncService");
      await vehiclePlateSyncService.reconcileLocationMemberChange(id, removedPersonIds);
    } catch {
      // 不阻擋名單寫入
    }
  }

  const syncMeta = await triggerDeviceSyncAfterMemberApply(id);
  const paged = await getPersonsByLocationIdPaged(id, { limit: 20, offset: 0 });
  return { ...paged, ...syncMeta };
}

async function getLocationMemberIds(locationId) {
  const id = await ensureLocationAllowsAccessMembers(locationId);
  const ids = await getPersonIdsByLocationId(id);
  return Array.from(
    new Set(
      (ids || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n)),
    ),
  );
}

async function getPersonsWithAccessByLocationId(locationId) {
  const rows = await db.query(
    `SELECT p.id, p.employee_no, p.full_name, p.status, p.face_url, p.config,
            p.person_group_id, pg.name AS group_name
     FROM person_location_access pla
     INNER JOIN persons p ON pla.person_id = p.id
     LEFT JOIN person_groups pg ON p.person_group_id = pg.id
     WHERE pla.location_id = ? AND p.status = 'active'
     ORDER BY p.employee_no`,
    [locationId],
  );
  return rows || [];
}

async function listLicensePlatesByLocationId(locationId) {
  const id = await ensureLocationAllowsAccessMembers(locationId);
  const rows = await db.query(
    `
      SELECT
        plp.id,
        plp.person_id,
        plp.plate_number,
        plp.plate_normalized,
        plp.list_type,
        plp.effective_begin,
        plp.effective_end,
        plp.isapi_sync_status,
        plp.isapi_sync_error,
        plp.isapi_synced_at,
        p.employee_no,
        p.full_name,
        p.status AS person_status
      FROM person_license_plates plp
      INNER JOIN person_location_access pla ON pla.person_id = plp.person_id
      INNER JOIN persons p ON p.id = plp.person_id
      WHERE pla.location_id = ?
      ORDER BY p.employee_no ASC, plp.id ASC
    `,
    [id],
  );
  return rows || [];
}

/**
 * 人員狀態變更時的車牌設備 reconcile（對齊人流 inactive 語意）
 */
async function onPersonStatusChange(personId, prevStatus, nextStatus) {
  const pid = Number(personId);
  if (!Number.isFinite(pid)) return;
  const prev = String(prevStatus || "").trim();
  const next = String(nextStatus || "").trim();
  if (prev === next) return;

  const vehiclePlateSyncService = require("../vehicleAccess/vehiclePlateSyncService");

  if (prev === "active" && next === "inactive") {
    await vehiclePlateSyncService.purgePersonPlatesFromDevices(pid);
    return;
  }
  if (prev === "inactive" && next === "active") {
    await vehiclePlateSyncService.syncPersonPlates(pid);
  }
}

module.exports = {
  ensureLocationAllowsAccessMembers,
  getPersonIdsByLocationId,
  getPersonsByLocationIdPaged,
  replaceLocationMembers,
  getLocationMemberIds,
  getPersonsWithAccessByLocationId,
  listLicensePlatesByLocationId,
  onPersonStatusChange,
  syncLicensePlatesForLocation,
};
