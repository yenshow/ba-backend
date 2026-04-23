/**
 * 人員主檔服務（門禁設備本系統）：人員群組、人員、門禁權限（person_location_access）。供人員管理 API 與門禁同步使用。
 */
const path = require("path");
const fs = require("fs").promises;
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("PersonnelService");
const accessControlService = require("../accessControl/accessControlService");

const VALID_STATUSES = ["active", "inactive", "deleted"];

function createValidationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function ensurePersonGroupExists(personGroupId) {
  if (personGroupId == null) return null;
  const id = Number(personGroupId);
  if (Number.isNaN(id)) throw createValidationError("群組無效");
  const rows = await db.query(
    "SELECT id FROM person_groups WHERE id = ? LIMIT 1",
    [id],
  );
  if (!rows || rows.length === 0) throw createValidationError("群組不存在");
  return id;
}

// ========== 人員群組 ==========

async function getPersonGroups(filters = {}) {
  let sql = "SELECT * FROM person_groups WHERE 1=1";
  const params = [];
  if (filters.name) {
    params.push(`%${filters.name}%`);
    sql += " AND name ILIKE ?";
  }
  sql += " ORDER BY name ASC";
  const rows = await db.query(sql, params);
  return rows;
}

async function getPersonGroupById(id) {
  const rows = await db.query("SELECT * FROM person_groups WHERE id = ?", [id]);
  if (!rows || rows.length === 0) {
    const err = new Error("人員群組不存在");
    err.statusCode = 404;
    throw err;
  }
  return rows[0];
}

async function createPersonGroup(data, createdBy = null) {
  const name = (data.name || "").trim();
  if (!name) throw createValidationError("群組名稱不能為空");
  const description = data.description ? String(data.description).trim() : null;
  const rows = await db.query(
    "INSERT INTO person_groups (name, description, created_by) VALUES (?, ?, ?) RETURNING *",
    [name, description, createdBy],
  );
  return rows[0];
}

async function updatePersonGroup(id, data) {
  await getPersonGroupById(id);
  const updates = [];
  const params = [];
  if (data.name !== undefined) {
    const name = (data.name || "").trim();
    if (!name) throw createValidationError("群組名稱不能為空");
    updates.push("name = ?");
    params.push(name);
  }
  if (data.description !== undefined) {
    updates.push("description = ?");
    params.push(data.description ? String(data.description).trim() : null);
  }
  if (updates.length === 0) return getPersonGroupById(id);
  params.push(id);
  await db.query(
    `UPDATE person_groups SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );
  return getPersonGroupById(id);
}

async function deletePersonGroup(id) {
  await getPersonGroupById(id);
  const refs = await db.query(
    "SELECT id FROM persons WHERE person_group_id = ? LIMIT 1",
    [id],
  );
  if (refs && refs.length > 0) {
    throw createValidationError("該群組下尚有人員，無法刪除");
  }
  await db.query("DELETE FROM person_groups WHERE id = ?", [id]);
  return { success: true };
}

async function ensureLocationExists(locationId) {
  const id = Number(locationId);
  if (Number.isNaN(id)) throw createValidationError("地點無效");
  const rows = await db.query("SELECT id FROM locations WHERE id = ? LIMIT 1", [
    id,
  ]);
  if (!rows || rows.length === 0) throw createValidationError("地點不存在");
  return id;
}

async function ensureLocationIsSyncable(locationId) {
  const id = await ensureLocationExists(locationId);
  const rows = await db.query(
    `
      SELECT l.id
      FROM locations l
      INNER JOIN location_systems ls
        ON l.id = ls.location_id AND ls.system_type = 'people_counting'
      WHERE l.id = ?
        AND (COALESCE(jsonb_array_length(ls.system_config->'entry_device_ids'), 0) > 0)
      LIMIT 1
    `,
    [id],
  );
  if (!rows || rows.length === 0) {
    throw createValidationError(
      "地點不可同步（需在人流統計設定門禁入口設備）",
    );
  }
  return id;
}

async function getPersonsByGroupId(personGroupId, options = {}) {
  const id = await ensurePersonGroupExists(personGroupId);
  const limit = clampInt(options.limit, { min: 1, max: 500, fallback: 200 });
  const offset = clampInt(options.offset, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: 0,
  });
  const status = options.status ? String(options.status).trim() : "";

  const whereParts = ["p.person_group_id = ?"];
  const params = [id];
  if (status) {
    params.push(status);
    whereParts.push("p.status = ?");
  }

  const countRows = await db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM persons p
      WHERE ${whereParts.join(" AND ")}
    `,
    params,
  );
  const total = countRows?.[0]?.total ?? 0;

  const rows = await db.query(
    `
      SELECT p.*, pg.name AS group_name
      FROM persons p
      LEFT JOIN person_groups pg ON p.person_group_id = pg.id
      WHERE ${whereParts.join(" AND ")}
      ORDER BY p.employee_no ASC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );
  return { items: rows || [], total, limit, offset };
}

async function replacePersonGroupMembers(personGroupId, memberPersonIds = []) {
  const id = await ensurePersonGroupExists(personGroupId);

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
      throw createValidationError(`人員不存在：${missing.join(", ")}`);
    }
  }

  await db.transaction(async (query) => {
    // 移出原本在此群組但不在 nextIds 的人
    if (nextIds.length === 0) {
      await query("UPDATE persons SET person_group_id = NULL WHERE person_group_id = ?", [
        id,
      ]);
    } else {
      await query(
        `UPDATE persons
         SET person_group_id = NULL
         WHERE person_group_id = ?
           AND id NOT IN (${nextIds.map(() => "?").join(",")})`,
        [id, ...nextIds],
      );
    }

    // 加入/移轉：將 nextIds 全部設為該群組（批次一次更新）
    if (nextIds.length > 0) {
      await query(
        `UPDATE persons SET person_group_id = ? WHERE id IN (${nextIds
          .map(() => "?")
          .join(",")})`,
        [id, ...nextIds],
      );
    }
  });

  return getPersonsByGroupId(id, { limit: 500, offset: 0 });
}

async function getPersonsByLocationIdPaged(locationId, options = {}) {
  const id = await ensureLocationIsSyncable(locationId);
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
  const id = await ensureLocationIsSyncable(locationId);

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
      throw createValidationError(`人員不存在：${missing.join(", ")}`);
    }
  }

  await db.transaction(async (query) => {
    await query("DELETE FROM person_location_access WHERE location_id = ?", [id]);
    for (const pid of nextIds) {
      await query(
        "INSERT INTO person_location_access (person_id, location_id) VALUES (?, ?)",
        [pid, id],
      );
    }
  });

  return getPersonsByLocationIdPaged(id, { limit: 20, offset: 0 });
}

// ========== 人員 ==========

async function getPersons(filters = {}) {
  let sql = `
    SELECT p.*, pg.name AS group_name
    FROM persons p
    LEFT JOIN person_groups pg ON p.person_group_id = pg.id
    WHERE 1=1
  `;
  const params = [];
  if (filters.personGroupId != null) {
    params.push(filters.personGroupId);
    sql += " AND p.person_group_id = ?";
  }
  if (filters.status) {
    params.push(filters.status);
    sql += " AND p.status = ?";
  }
  if (filters.employeeNo) {
    params.push(`%${filters.employeeNo}%`);
    sql += " AND p.employee_no ILIKE ?";
  }
  if (filters.fullName) {
    params.push(`%${filters.fullName}%`);
    sql += " AND p.full_name ILIKE ?";
  }
  sql += " ORDER BY p.employee_no ASC";
  const rows = await db.query(sql, params);
  return rows;
}

function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

async function getPersonsPaged(filters = {}, options = {}) {
  const limit = clampInt(options.limit, { min: 1, max: 200, fallback: 10 });
  const offset = clampInt(options.offset, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: 0,
  });

  const sortByRaw = options.sortBy != null ? String(options.sortBy).trim() : "";
  const sortOrderRaw = options.sortOrder != null ? String(options.sortOrder).trim() : "";
  const sortBy = sortByRaw || "employeeNo";
  const sortOrder = ["asc", "desc"].includes(sortOrderRaw.toLowerCase())
    ? sortOrderRaw.toLowerCase()
    : "asc";

  const SORT_COLUMNS = {
    employeeNo: "p.employee_no",
    employee_no: "p.employee_no",
  };
  const orderColumn = SORT_COLUMNS[sortBy] || SORT_COLUMNS.employeeNo;
  const orderSql = `${orderColumn} ${sortOrder.toUpperCase()}`;

  const whereParts = ["1=1"];
  const params = [];

  if (filters.personGroupId != null) {
    params.push(filters.personGroupId);
    whereParts.push("p.person_group_id = ?");
  }
  if (filters.status) {
    params.push(filters.status);
    whereParts.push("p.status = ?");
  }
  if (filters.employeeNo) {
    params.push(`%${filters.employeeNo}%`);
    whereParts.push("p.employee_no ILIKE ?");
  }
  if (filters.fullName) {
    params.push(`%${filters.fullName}%`);
    whereParts.push("p.full_name ILIKE ?");
  }
  if (filters.q) {
    const q = String(filters.q).trim();
    if (q) {
      params.push(`%${q}%`);
      params.push(`%${q}%`);
      whereParts.push("(p.employee_no ILIKE ? OR p.full_name ILIKE ?)");
    }
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  const countRows = await db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM persons p
      ${whereSql}
    `,
    params,
  );
  const total = countRows?.[0]?.total ?? 0;

  const rows = await db.query(
    `
      SELECT
        p.*,
        pg.name AS group_name,
        COALESCE(al.access_locations, '[]'::json) AS access_locations
      FROM persons p
      LEFT JOIN person_groups pg ON p.person_group_id = pg.id
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'location_id', pla.location_id,
            'zone_name', z.name,
            'location_name', l.name,
            'zone_id', l.zone_id
          )
          ORDER BY z.name, l.name
        ) AS access_locations
        FROM person_location_access pla
        INNER JOIN locations l ON pla.location_id = l.id
        INNER JOIN zones z ON l.zone_id = z.id
        WHERE pla.person_id = p.id
      ) al ON TRUE
      ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );

  return { items: rows || [], total, limit, offset };
}

async function getPersonById(id) {
  const rows = await db.query(
    `SELECT p.*, pg.name AS group_name
     FROM persons p
     LEFT JOIN person_groups pg ON p.person_group_id = pg.id
     WHERE p.id = ?`,
    [id],
  );
  if (!rows || rows.length === 0) {
    const err = new Error("人員不存在");
    err.statusCode = 404;
    throw err;
  }
  return rows[0];
}

async function getPersonByEmployeeNo(employeeNo) {
  const rows = await db.query("SELECT * FROM persons WHERE employee_no = ?", [
    String(employeeNo),
  ]);
  return rows && rows.length > 0 ? rows[0] : null;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  const s = value.trim();
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function createPerson(data, createdBy = null) {
  // 群組成員管理已集中到 /api/personnel/groups/:id/members（SSOT: persons.person_group_id）
  if (
    Object.prototype.hasOwnProperty.call(data || {}, "personGroupId") ||
    Object.prototype.hasOwnProperty.call(data || {}, "person_group_id")
  ) {
    throw createValidationError(
      "建立人員不支援設定群組（請至「人員群組」管理成員）",
    );
  }

  const employeeNo = (data.employeeNo || "").toString().trim();
  if (!employeeNo) throw createValidationError("員工編號不能為空");
  const fullNameRaw = data.fullName != null ? String(data.fullName).trim() : "";
  if (!fullNameRaw) throw createValidationError("姓名為必填");

  const status =
    data.status && VALID_STATUSES.includes(data.status)
      ? data.status
      : "active";
  const faceUrl = data.faceUrl != null ? data.faceUrl : null;
  const config =
    data.config != null
      ? typeof data.config === "string"
        ? parseJson(data.config, null)
        : data.config
      : null;
  const userId = data.userId != null ? data.userId : null;

  const existing = await getPersonByEmployeeNo(employeeNo);
  if (existing) throw createValidationError("員工編號已存在");

  const rows = await db.query(
    `INSERT INTO persons (employee_no, full_name, person_group_id, status, face_url, config, created_by, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      employeeNo,
      fullNameRaw,
      null,
      status,
      faceUrl || null,
      config ? JSON.stringify(config) : null,
      createdBy,
      userId || null,
    ],
  );
  return rows[0];
}

async function updatePerson(id, data) {
  const existingPerson = await getPersonById(id);

  // 群組成員管理已集中到 /api/personnel/groups/:id/members（SSOT: persons.person_group_id）
  if (
    Object.prototype.hasOwnProperty.call(data || {}, "personGroupId") ||
    Object.prototype.hasOwnProperty.call(data || {}, "person_group_id")
  ) {
    throw createValidationError(
      "更新人員不支援修改群組（請至「人員群組」管理成員）",
    );
  }

  const updates = [];
  const params = [];
  if (data.employeeNo !== undefined) {
    const v = String(data.employeeNo).trim();
    if (!v) throw createValidationError("員工編號不能為空");
    const existing = await getPersonByEmployeeNo(v);
    if (existing && existing.id !== id)
      throw createValidationError("員工編號已存在");
    updates.push("employee_no = ?");
    params.push(v);
  }
  if (data.fullName !== undefined) {
    const v = data.fullName != null ? String(data.fullName).trim() : "";
    if (!v) throw createValidationError("姓名為必填");
    updates.push("full_name = ?");
    params.push(v);
  }
  if (data.status !== undefined) {
    if (!VALID_STATUSES.includes(data.status))
      throw createValidationError("無效的狀態");
    updates.push("status = ?");
    params.push(data.status);
  }
  if (data.faceUrl !== undefined) {
    const nextFaceUrl = data.faceUrl ?? null;
    updates.push("face_url = ?");
    params.push(nextFaceUrl);

    // 若清空 face_url，刪除 uploads/personnel 內舊檔，避免幽靈檔案
    // 僅處理平台本機路徑（/uploads/personnel/...），外部 URL 不處理
    const prev = existingPerson?.face_url;
    const prevStr = typeof prev === "string" ? prev.trim() : "";
    if (nextFaceUrl == null && prevStr.startsWith("/uploads/personnel/")) {
      const filename = path.basename(prevStr);
      if (filename && !filename.includes("..")) {
        const filePath = path.join(process.cwd(), "uploads", "personnel", filename);
        fs.unlink(filePath).catch(() => null);
      }
    }
  }
  if (data.config !== undefined) {
    updates.push("config = ?");
    params.push(
      typeof data.config === "string"
        ? data.config
        : JSON.stringify(data.config),
    );
  }
  if (data.userId !== undefined) {
    updates.push("user_id = ?");
    params.push(data.userId ?? null);
  }
  if (updates.length === 0) return getPersonById(id);
  params.push(id);
  await db.query(
    `UPDATE persons SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );
  return getPersonById(id);
}

// ========== 門禁資料（僅存平台，設備同步統一處理） ==========

// ========== 有效期限（Valid；僅存平台，設備同步統一處理） ==========

function normalizeIsapiTimeString(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  // 支援 yyyy-mm-dd（from <input type="date">）
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00`;
  // 支援 yyyy-mm-ddThh:mm:ss（不含 Z/millis）
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  // 支援 ISO，統一轉為不含毫秒與 Z 的格式
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

function isBeginBeforeEnd(beginTime, endTime) {
  const b = new Date(beginTime).getTime();
  const e = new Date(endTime).getTime();
  if (!Number.isFinite(b) || !Number.isFinite(e)) return false;
  return b <= e;
}

function upsertFingerPrint(list, params = {}) {
  const fingerData = String(params.fingerData || "").trim();
  const fpIdRaw = params.fingerPrintID == null ? 1 : params.fingerPrintID;
  const fpId = Number.parseInt(String(fpIdRaw), 10);
  if (Number.isNaN(fpId) || fpId < 1 || fpId > 10) {
    throw createValidationError("fingerPrintID 無效（允許範圍 1~10）");
  }
  const next = Array.isArray(list) ? list.filter((x) => x && Number(x.fingerPrintID) !== fpId) : [];
  if (!fingerData) return next;
  next.push({
    fingerPrintID: fpId,
    fingerType: "normalFP",
    fingerData,
    enableCardReader: [1],
  });
  return next;
}

function buildValidityPayload(params = {}) {
  const longTerm =
    params.longTerm !== undefined
      ? Boolean(params.longTerm)
      : true;
  const beginTimeRaw = params.beginTime ?? null;
  const endTimeRaw = params.endTime ?? null;
  let beginTime = normalizeIsapiTimeString(beginTimeRaw);
  let endTime = normalizeIsapiTimeString(endTimeRaw);

  // 長期授權：允許未提供日期，後端自動補齊避免同步工作失敗（常見於批次匯入/外部資料來源）
  if (longTerm && (!beginTime || !endTime)) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    beginTime = `${today}T00:00:00`;
    endTime = "2035-12-31T23:59:59";
  }

  if (!beginTime || !endTime) throw createValidationError("請提供有效期限（beginTime / endTime）");
  if (!isBeginBeforeEnd(beginTime, endTime)) {
    throw createValidationError("有效期限起訖不正確（beginTime 必須小於等於 endTime）");
  }
  return { longTerm, beginTime, endTime };
}

async function setPersonAccessControlConfig(personId, params = {}) {
  const person = await getPersonById(personId);
  const config = parseJson(person.config, {}) || {};
  config.access_control = config.access_control || {};

  // validity（必填：同步 UserInfo 需要）
  if (params.validity != null || params.beginTime != null || params.endTime != null || params.longTerm != null) {
    const v = params.validity && typeof params.validity === "object" ? params.validity : params;
    config.access_control.validity = buildValidityPayload(v);
  }

  // cardNo（允許 null/"" 代表清除）
  if (Object.prototype.hasOwnProperty.call(params, "cardNo")) {
    const cardNo = params.cardNo == null ? "" : String(params.cardNo).trim();
    if (!cardNo) delete config.access_control.cardNo;
    else config.access_control.cardNo = cardNo;
  }

  // password（允許 null 代表清除；僅數字 4~12）
  if (Object.prototype.hasOwnProperty.call(params, "password")) {
    const pwRaw = params.password;
    const pw = pwRaw == null ? null : String(pwRaw).trim();
    if (pw != null) {
      if (!pw) throw createValidationError("密碼不能為空");
      if (!/^\d+$/.test(pw)) throw createValidationError("密碼僅允許數字");
      if (pw.length < 4 || pw.length > 12) throw createValidationError("密碼長度需為 4~12 碼");
    }
    if (pw == null) delete config.access_control.password;
    else config.access_control.password = pw;
  }

  // fingerData（允許 null/"" 代表清除 fingerPrintID=1）
  if (Object.prototype.hasOwnProperty.call(params, "fingerData")) {
    const fingerData = String(params.fingerData ?? "").trim();
    const list = Array.isArray(config.access_control.fingerprints) ? config.access_control.fingerprints : [];
    config.access_control.fingerprints = upsertFingerPrint(list, { fingerData, fingerPrintID: 1 });
  }

  await db.query("UPDATE persons SET config = ? WHERE id = ?", [
    JSON.stringify(config),
    personId,
  ]);
  return getPersonById(personId);
}

async function deletePerson(id) {
  await getPersonById(id);
  await db.query("DELETE FROM person_location_access WHERE person_id = ?", [
    id,
  ]);
  await db.query("DELETE FROM persons WHERE id = ?", [id]);
  return { success: true };
}

async function getPersonIdsByLocationId(locationId) {
  const rows = await db.query(
    "SELECT person_id FROM person_location_access WHERE location_id = ?",
    [locationId],
  );
  return (rows || []).map((r) => r.person_id);
}

async function getPersonsWithAccessByLocationId(locationId) {
  const rows = await db.query(
    `SELECT p.id, p.employee_no, p.full_name, p.status, p.face_url, p.config, pg.name AS group_name
     FROM person_location_access pla
     INNER JOIN persons p ON pla.person_id = p.id
     LEFT JOIN person_groups pg ON p.person_group_id = pg.id
     WHERE pla.location_id = ? AND p.status = 'active'
     ORDER BY p.employee_no`,
    [locationId],
  );
  return rows || [];
}

module.exports = {
  getPersonGroups,
  getPersonGroupById,
  createPersonGroup,
  updatePersonGroup,
  deletePersonGroup,
  getPersonsByGroupId,
  replacePersonGroupMembers,
  getPersonsByLocationIdPaged,
  replaceLocationMembers,
  getPersons,
  getPersonsPaged,
  getPersonById,
  getPersonByEmployeeNo,
  createPerson,
  updatePerson,
  deletePerson,
  getPersonIdsByLocationId,
  getPersonsWithAccessByLocationId,
  setPersonAccessControlConfig,
};
