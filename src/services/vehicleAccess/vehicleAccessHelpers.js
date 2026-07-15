/**
 * 車輛進出共用 helpers：方向正規化、車牌→人員 enrich
 */
const db = require("../../database/db");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");

function parseLaneId(value) {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * ISAPI／無地點設定時：依 lane_info.lane_type（1 進 2 出）
 * @param {{ allow_result?: number, lane_type?: number|null }} record
 * @returns {'entry'|'exit'|null}
 */
function normalizeVehicleDirection(record) {
  if (record?.allow_result !== 1) return null;
  const lt = record.lane_type != null ? Number(record.lane_type) : null;
  if (lt === 1) return "entry";
  if (lt === 2) return "exit";
  return null;
}

/**
 * YSCP：優先依地點 entryLaneId／exitLaneId；無匹配時 fallback lane_type
 */
function createVehicleDirectionResolver(entryLaneId, exitLaneId) {
  const entry = parseLaneId(entryLaneId);
  const exit = parseLaneId(exitLaneId);

  return (record) => {
    if (record?.allow_result !== 1) return null;
    const laneId = parseLaneId(record.lane_id);
    if (laneId != null) {
      if (entry != null && laneId === entry) return "entry";
      if (exit != null && laneId === exit) return "exit";
    }
    return normalizeVehicleDirection(record);
  };
}

async function lookupPersonByPlate(licensePlate) {
  const norm = normalizePlate(licensePlate);
  if (!norm) return null;
  const rows = await db.query(
    `
      SELECT p.id, p.full_name, p.person_group_id, pg.name AS group_name
      FROM person_license_plates plp
      INNER JOIN persons p ON p.id = plp.person_id
      LEFT JOIN person_groups pg ON pg.id = p.person_group_id
      WHERE plp.plate_normalized = ?
      ORDER BY plp.id ASC
      LIMIT 1
    `,
    [norm],
  );
  const r = rows?.[0];
  if (!r) return null;
  return {
    personId: r.id,
    ownerName: r.full_name != null ? String(r.full_name).trim() : "",
    personGroupId: r.person_group_id != null ? Number(r.person_group_id) : null,
    personGroupName: r.group_name != null ? String(r.group_name).trim() : "",
  };
}

async function enrichLogsWithPerson(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return logs;
  const plates = [
    ...new Set(
      logs.map((l) => normalizePlate(l.license_plate)).filter(Boolean),
    ),
  ];
  if (plates.length === 0) return logs;

  const placeholders = plates.map(() => "?").join(",");
  const rows = await db.query(
    `
      SELECT plp.plate_normalized, p.id AS person_id, p.full_name,
             p.person_group_id, pg.name AS group_name
      FROM person_license_plates plp
      INNER JOIN persons p ON p.id = plp.person_id
      LEFT JOIN person_groups pg ON pg.id = p.person_group_id
      WHERE plp.plate_normalized IN (${placeholders})
    `,
    plates,
  );
  const byPlate = new Map();
  for (const r of rows || []) {
    const key = r.plate_normalized;
    if (!byPlate.has(key)) {
      byPlate.set(key, {
        ownerName: r.full_name != null ? String(r.full_name).trim() : "",
        personGroupId:
          r.person_group_id != null ? Number(r.person_group_id) : null,
        personGroupName: r.group_name != null ? String(r.group_name).trim() : "",
      });
    }
  }

  return logs.map((log) => {
    const key = normalizePlate(log.license_plate);
    const info = key ? byPlate.get(key) : null;
    if (!info) return log;
    return {
      ...log,
      owner_name: log.owner_name || info.ownerName || null,
      person_group_name: info.personGroupName || log.person_group_name || null,
      organization_id: info.personGroupId ?? log.organization_id ?? null,
    };
  });
}

module.exports = {
  parseLaneId,
  normalizeVehicleDirection,
  createVehicleDirectionResolver,
  lookupPersonByPlate,
  enrichLogsWithPerson,
};
