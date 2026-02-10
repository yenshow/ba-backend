/**
 * 人流統計記錄同步服務
 * 將外部 baseacs.slot_card_records 同步至主庫 people_counting_logs，供備份使用
 */

const externalDb = require("../../database/externalDb");
const db = require("../../database/db");
const locationService = require("./locationService");

/**
 * 取得 physical_id -> location_id 映射
 */
async function getPhysicalIdToLocationMap() {
  const result = await locationService.getZones({ locationType: "people_counting" });
  const map = new Map();

  for (const zone of result.zones || []) {
    for (const loc of zone.locations || []) {
      const sys = (loc.systems || []).find((s) => s.systemType === "people_counting");
      const entryId = sys?.config?.entryDoorId;
      const exitId = sys?.config?.exitDoorId;
      const locId = loc.id;

      if (entryId != null) map.set(Number(entryId), locId);
      if (exitId != null) map.set(Number(exitId), locId);
    }
  }

  return map;
}

/**
 * 同步指定日期範圍的刷卡記錄
 * @param {Date} start - 開始時間（含）
 * @param {Date} end - 結束時間（含）
 * @returns {Promise<{ synced: number }>}
 */
async function syncRecords(start, end) {
  const sql = `
    SELECT 
      r.person_id,
      r.swip_card_rev_time,
      r.physical_id,
      r.snap_pic_url,
      p.full_name AS person_name,
      p.person_group_id AS unit_id,
      pg.name AS unit_name
    FROM baseacs.slot_card_records r
    LEFT JOIN platform.person p ON r.person_id = p.id
    LEFT JOIN platform.person_group pg ON p.person_group_id = pg.id
    WHERE r.is_deleted = false
      AND r.swip_card_rev_time >= $1
      AND r.swip_card_rev_time <= $2
    ORDER BY r.swip_card_rev_time ASC
  `;

  const rows = await externalDb.query(sql, [start.toISOString(), end.toISOString()]);
  if (!rows || rows.length === 0) {
    return { synced: 0 };
  }

  const physicalMap = await getPhysicalIdToLocationMap();
  const params = [];
  const values = [];
  let idx = 1;
  for (const row of rows) {
    const locationId = row.physical_id != null ? physicalMap.get(Number(row.physical_id)) ?? null : null;
    values.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    params.push(
      null,
      row.person_id,
      row.swip_card_rev_time,
      row.physical_id ?? null,
      row.person_name ?? null,
      row.unit_id ?? null,
      row.unit_name ?? null,
      row.snap_pic_url ?? null,
      locationId
    );
  }

  const insertSql = `
    INSERT INTO people_counting_logs 
    (external_id, person_id, swip_card_rev_time, physical_id, person_name, unit_id, unit_name, snap_pic_url, location_id)
    VALUES ${values.join(", ")}
    ON CONFLICT (person_id, swip_card_rev_time) DO NOTHING
  `;
  const result = await db.query(insertSql, params);
  const inserted = result?.rowCount ?? 0;

  return { synced: inserted };
}

/**
 * 同步「昨日」的記錄（供每日排程呼叫）
 * @returns {Promise<{ synced: number }>}
 */
async function syncYesterday() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59, 999)
  );
  return syncRecords(start, end);
}

/**
 * 同步指定天數前的單日記錄
 * @param {number} daysAgo - 幾天前（1 = 昨天）
 */
async function syncDayAgo(daysAgo) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 0, 0, 0, 0));
  const start = d;
  const end = new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
  return syncRecords(start, end);
}

/**
 * 同步備份 cutoff 之前的記錄（分日同步，避免單次查詢過大）
 * @param {Date} cutoff - 截止時間，只同步 swip_card_rev_time < cutoff 的記錄
 * @param {number} maxDays - 單次最多同步幾天（預設 7）
 */
async function syncBeforeCutoff(cutoff, maxDays = 7) {
  let totalSynced = 0;
  const dayMs = 24 * 60 * 60 * 1000;

  for (let d = 1; d <= maxDays; d++) {
    const end = new Date(cutoff.getTime() - (d - 1) * dayMs);
    const start = new Date(end.getTime() - dayMs + 1);

    if (start.getTime() < 0) break;

    const { synced } = await syncRecords(start, end);
    totalSynced += synced;
  }

  return { synced: totalSynced };
}

/**
 * 取得 physical_id -> 方向（entry/exit）映射（供備份統計進出場人數）
 * @returns {Promise<Map<number, 'entry'|'exit'>>}
 */
async function getPhysicalIdToDirectionMap() {
  const map = new Map();
  const result = await locationService.getZones({ locationType: "people_counting" });
  for (const zone of result.zones || []) {
    for (const loc of zone.locations || []) {
      const sys = (loc.systems || []).find((s) => s.systemType === "people_counting");
      const entryId = sys?.config?.entryDoorId;
      const exitId = sys?.config?.exitDoorId;
      if (entryId != null) map.set(Number(entryId), "entry");
      if (exitId != null) map.set(Number(exitId), "exit");
    }
  }
  return map;
}

/**
 * 取得 physical_id -> 設備名稱 映射（供備份使用）
 * 從 deviceaccess.door 查詢 dev_name
 * @param {number[]} physicalIds - physical_id 列表
 * @returns {Promise<Map<number, string>>}
 */
async function getDoorNamesByPhysicalIds(physicalIds) {
  const map = new Map();
  if (!physicalIds || physicalIds.length === 0) return map;

  const uniqueIds = [...new Set(physicalIds)].filter((id) => id != null && id !== "");
  if (uniqueIds.length === 0) return map;

  try {
    const placeholders = uniqueIds.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await externalDb.query(
      `SELECT id, dev_name FROM deviceaccess.door WHERE id IN (${placeholders})`,
      uniqueIds
    );
    for (const row of rows || []) {
      map.set(Number(row.id), row.dev_name ?? "");
    }
  } catch (error) {
    console.warn("[peopleCountingSyncService] 取得門設備名稱失敗:", error.message);
  }
  return map;
}

module.exports = {
  syncRecords,
  syncYesterday,
  syncDayAgo,
  syncBeforeCutoff,
  getDoorNamesByPhysicalIds,
  getPhysicalIdToDirectionMap,
};
