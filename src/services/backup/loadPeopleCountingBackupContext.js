/**
 * 備份用：地點／設備 → 區域-地點、進出方向、設備名稱
 */
const db = require("../../database/db");
const { getDeviceNameByIds } = require("../../utils/deviceHelpers");
const {
  parsePeopleCountingConfigFields,
} = require("../peopleCounting/peopleCountingConfig");

function parseConfig(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function toIdList(v) {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
}

function putDevice(
  map,
  allDeviceIds,
  id,
  info,
  { overwrite = true } = {},
) {
  allDeviceIds.add(id);
  if (!overwrite && map.has(id)) return;
  map.set(id, info);
}

/**
 * @returns {Promise<{
 *   accessByDeviceId: Map<number, object>,
 *   faceByDeviceId: Map<number, object>,
 * }>}
 */
async function loadPeopleCountingBackupContext() {
  const rows = await db.query(
    `SELECT
       l.name AS location_name,
       z.name AS zone_name,
       ls.system_config
     FROM location_systems ls
     INNER JOIN locations l ON l.id = ls.location_id
     LEFT JOIN zones z ON z.id = l.zone_id
     WHERE ls.system_type = 'people_counting'`,
  );

  const accessByDeviceId = new Map();
  const faceByDeviceId = new Map();
  const allDeviceIds = new Set();

  for (const r of rows || []) {
    const cfg = parseConfig(r.system_config);
    const dataSource = String(cfg.data_source ?? cfg.dataSource ?? "").trim();
    const zoneName = r.zone_name != null ? String(r.zone_name) : "";
    const locationName = r.location_name != null ? String(r.location_name) : "";
    const base = { zoneName, locationName, deviceName: "" };

    if (dataSource === "access_control") {
      for (const id of toIdList(cfg.entry_device_ids ?? cfg.entryDeviceIds)) {
        putDevice(accessByDeviceId, allDeviceIds, id, {
          ...base,
          direction: "entry",
        });
      }
      for (const id of toIdList(cfg.exit_device_ids ?? cfg.exitDeviceIds)) {
        // 同機不可同時進出；衝突保留先寫入的 entry
        putDevice(
          accessByDeviceId,
          allDeviceIds,
          id,
          { ...base, direction: "exit" },
          { overwrite: false },
        );
      }
      continue;
    }

    if (dataSource !== "isapi_camera") continue;
    const parsed = parsePeopleCountingConfigFields(cfg);
    if (parsed.cameraMode !== "face_recognition") continue;
    const faceBase = {
      ...base,
      faceSimilarityThreshold: parsed.faceSimilarityThreshold,
    };
    for (const id of toIdList(parsed.entryCameraDeviceIds)) {
      putDevice(faceByDeviceId, allDeviceIds, id, {
        ...faceBase,
        direction: "entry",
      });
    }
    for (const id of toIdList(parsed.exitCameraDeviceIds)) {
      putDevice(
        faceByDeviceId,
        allDeviceIds,
        id,
        { ...faceBase, direction: "exit" },
        { overwrite: false },
      );
    }
  }

  const nameById = await getDeviceNameByIds([...allDeviceIds]);
  for (const [id, info] of accessByDeviceId) {
    info.deviceName = nameById.get(id) || "";
  }
  for (const [id, info] of faceByDeviceId) {
    info.deviceName = nameById.get(id) || "";
  }

  return { accessByDeviceId, faceByDeviceId };
}

/**
 * @param {string[]} employeeNos
 * @returns {Promise<Map<string, { personName: string, groupName: string, personId: number|null }>>}
 */
async function loadPersonsByEmployeeNos(employeeNos) {
  const map = new Map();
  const nos = [
    ...new Set(
      (employeeNos || [])
        .map((n) => (n != null ? String(n).trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (nos.length === 0) return map;
  const placeholders = nos.map(() => "?").join(",");
  const rows = await db.query(
    `SELECT p.id, p.employee_no, p.full_name, pg.name AS group_name
     FROM persons p
     LEFT JOIN person_groups pg ON p.person_group_id = pg.id
     WHERE p.employee_no IN (${placeholders})`,
    nos,
  );
  for (const r of rows || []) {
    const no = r.employee_no != null ? String(r.employee_no).trim() : "";
    if (!no) continue;
    map.set(no, {
      personId: r.id != null ? Number(r.id) : null,
      personName: r.full_name != null ? String(r.full_name).trim() : "",
      groupName: r.group_name != null ? String(r.group_name).trim() : "",
    });
  }
  return map;
}

module.exports = {
  loadPeopleCountingBackupContext,
  loadPersonsByEmployeeNos,
};
