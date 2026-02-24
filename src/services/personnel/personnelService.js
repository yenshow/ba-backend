/**
 * 人員主檔服務（門禁設備本系統）：人員群組、人員、門禁權限（person_location_access）。供人員管理 API 與門禁同步使用。
 */
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("PersonnelService");

const VALID_STATUSES = ["active", "inactive", "deleted"];

function createValidationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
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
    [name, description, createdBy]
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
    params
  );
  return getPersonGroupById(id);
}

async function deletePersonGroup(id) {
  await getPersonGroupById(id);
  const refs = await db.query(
    "SELECT id FROM persons WHERE person_group_id = ? LIMIT 1",
    [id]
  );
  if (refs && refs.length > 0) {
    throw createValidationError("該群組下尚有人員，無法刪除");
  }
  await db.query("DELETE FROM person_groups WHERE id = ?", [id]);
  return { success: true };
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

async function getPersonById(id) {
  const rows = await db.query(
    `SELECT p.*, pg.name AS group_name
     FROM persons p
     LEFT JOIN person_groups pg ON p.person_group_id = pg.id
     WHERE p.id = ?`,
    [id]
  );
  if (!rows || rows.length === 0) {
    const err = new Error("人員不存在");
    err.statusCode = 404;
    throw err;
  }
  return rows[0];
}

async function getPersonByEmployeeNo(employeeNo) {
  const rows = await db.query(
    "SELECT * FROM persons WHERE employee_no = ?",
    [String(employeeNo)]
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

async function createPerson(data, createdBy = null) {
  const employeeNo = (data.employeeNo || data.employee_no || "").toString().trim();
  if (!employeeNo) throw createValidationError("員工編號不能為空");
  const fullName = data.fullName != null ? String(data.fullName).trim() : (data.full_name != null ? String(data.full_name).trim() : null);
  const personGroupId = data.personGroupId != null ? data.personGroupId : (data.person_group_id != null ? data.person_group_id : null);
  const status = data.status && VALID_STATUSES.includes(data.status) ? data.status : "active";
  const faceUrl = data.faceUrl != null ? data.faceUrl : data.face_url;
  const config = data.config != null ? (typeof data.config === "string" ? JSON.parse(data.config) : data.config) : null;
  const userId = data.userId != null ? data.userId : data.user_id;

  const existing = await getPersonByEmployeeNo(employeeNo);
  if (existing) throw createValidationError("員工編號已存在");

  const rows = await db.query(
    `INSERT INTO persons (employee_no, full_name, person_group_id, status, face_url, config, created_by, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      employeeNo,
      fullName,
      personGroupId || null,
      status,
      faceUrl || null,
      config ? JSON.stringify(config) : null,
      createdBy,
      userId || null,
    ]
  );
  return rows[0];
}

async function updatePerson(id, data) {
  await getPersonById(id);
  const updates = [];
  const params = [];
  if (data.employeeNo !== undefined || data.employee_no !== undefined) {
    const v = (data.employeeNo ?? data.employee_no).toString().trim();
    if (!v) throw createValidationError("員工編號不能為空");
    const existing = await getPersonByEmployeeNo(v);
    if (existing && existing.id !== id) throw createValidationError("員工編號已存在");
    updates.push("employee_no = ?");
    params.push(v);
  }
  if (data.fullName !== undefined || data.full_name !== undefined) {
    updates.push("full_name = ?");
    params.push((data.fullName ?? data.full_name) != null ? String(data.fullName ?? data.full_name).trim() : null);
  }
  if (data.personGroupId !== undefined || data.person_group_id !== undefined) {
    updates.push("person_group_id = ?");
    params.push(data.personGroupId ?? data.person_group_id ?? null);
  }
  if (data.status !== undefined) {
    if (!VALID_STATUSES.includes(data.status)) throw createValidationError("無效的狀態");
    updates.push("status = ?");
    params.push(data.status);
  }
  if (data.faceUrl !== undefined || data.face_url !== undefined) {
    updates.push("face_url = ?");
    params.push(data.faceUrl ?? data.face_url ?? null);
  }
  if (data.config !== undefined) {
    updates.push("config = ?");
    params.push(typeof data.config === "string" ? data.config : JSON.stringify(data.config));
  }
  if (data.userId !== undefined || data.user_id !== undefined) {
    updates.push("user_id = ?");
    params.push(data.userId ?? data.user_id ?? null);
  }
  if (updates.length === 0) return getPersonById(id);
  params.push(id);
  await db.query(`UPDATE persons SET ${updates.join(", ")} WHERE id = ?`, params);
  return getPersonById(id);
}

async function deletePerson(id) {
  await getPersonById(id);
  await db.query("DELETE FROM person_location_access WHERE person_id = ?", [id]);
  await db.query("DELETE FROM persons WHERE id = ?", [id]);
  return { success: true };
}

// ========== 門禁權限（人員 ↔ 地點） ==========

async function getAccessLocationsByPersonId(personId) {
  const person = await getPersonById(personId);
  const rows = await db.query(
    `SELECT pla.location_id, l.name AS location_name, z.name AS zone_name, l.zone_id
     FROM person_location_access pla
     INNER JOIN locations l ON pla.location_id = l.id
     INNER JOIN zones z ON l.zone_id = z.id
     WHERE pla.person_id = ?
     ORDER BY z.name, l.name`,
    [personId]
  );
  return {
    person: { id: person.id, employeeNo: person.employee_no, fullName: person.full_name },
    locations: rows,
  };
}

async function setAccessLocationsForPerson(personId, locationIds) {
  await getPersonById(personId);
  const ids = Array.isArray(locationIds) ? locationIds.map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x)) : [];
  await db.transaction(async (query) => {
    await query("DELETE FROM person_location_access WHERE person_id = ?", [personId]);
    for (const lid of ids) {
      await query(
        "INSERT INTO person_location_access (person_id, location_id) VALUES (?, ?)",
        [personId, lid]
      );
    }
  });
  return getAccessLocationsByPersonId(personId);
}

async function getPersonIdsByLocationId(locationId) {
  const rows = await db.query(
    "SELECT person_id FROM person_location_access WHERE location_id = ?",
    [locationId]
  );
  return (rows || []).map((r) => r.person_id);
}

async function getPersonsWithAccessByLocationId(locationId) {
  const rows = await db.query(
    `SELECT p.id, p.employee_no, p.full_name, p.status, p.face_url, pg.name AS group_name
     FROM person_location_access pla
     INNER JOIN persons p ON pla.person_id = p.id
     LEFT JOIN person_groups pg ON p.person_group_id = pg.id
     WHERE pla.location_id = ? AND p.status = 'active'
     ORDER BY p.employee_no`,
    [locationId]
  );
  return rows || [];
}

module.exports = {
  getPersonGroups,
  getPersonGroupById,
  createPersonGroup,
  updatePersonGroup,
  deletePersonGroup,
  getPersons,
  getPersonById,
  getPersonByEmployeeNo,
  createPerson,
  updatePerson,
  deletePerson,
  getAccessLocationsByPersonId,
  setAccessLocationsForPerson,
  getPersonIdsByLocationId,
  getPersonsWithAccessByLocationId,
};
