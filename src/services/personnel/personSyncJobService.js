/**
 * 人員門禁同步服務（同步執行，無佇列）
 * 依地點取得有權限人員，對入口/出口設備依序執行 ISAPI 新增/刪除
 */
const db = require("../../database/db");
const accessControlService = require("../accessControl/accessControlService");
const personnelService = require("./personnelService");
const logger = require("../../utils/logger").createLogger("PersonSyncService");

const SYNC_DELAY_MS = 300;

function createValidationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * 取得地點的 people_counting 設定（entry/exit 門禁設備 ID）
 */
async function getPeopleCountingDevicesForLocation(locationId) {
  const rows = await db.query(
    "SELECT system_config FROM location_systems WHERE location_id = ? AND system_type = 'people_counting' LIMIT 1",
    [locationId]
  );
  if (!rows || rows.length === 0) return null;
  const config = rows[0].system_config;
  const raw = typeof config === "string" ? JSON.parse(config) : config || {};
  const entryDeviceId = raw.entry_device_id ?? raw.entryDeviceId;
  const exitDeviceId = raw.exit_device_id ?? raw.exitDeviceId;
  if (entryDeviceId == null) return null;
  return {
    entryDeviceId: Number(entryDeviceId),
    exitDeviceId: exitDeviceId != null ? Number(exitDeviceId) : null,
  };
}

/**
 * 取得所有可同步的地點（有 people_counting 且具 entry_device_id）
 */
async function getSyncableLocations() {
  const rows = await db.query(
    `SELECT l.id, l.name, z.name AS zone_name
     FROM locations l
     INNER JOIN zones z ON l.zone_id = z.id
     INNER JOIN location_systems ls ON l.id = ls.location_id AND ls.system_type = 'people_counting'
     WHERE (ls.system_config->>'entry_device_id') IS NOT NULL AND (ls.system_config->>'entry_device_id') != ''
     ORDER BY z.name, l.name`,
    []
  );
  return rows || [];
}

/**
 * 取得設備上所有人員的 employeeNo 列表（分頁取完）
 */
async function fetchAllEmployeeNosFromDevice(deviceId) {
  const result = [];
  let position = 0;
  const maxResults = 50;
  for (;;) {
    const res = await accessControlService.searchUserInfo(deviceId, { searchResultPosition: position, maxResults });
    const list = res.list || [];
    for (const u of list) {
      if (u.employeeNo != null) result.push(String(u.employeeNo));
    }
    const total = res.totalMatches ?? 0;
    position += list.length;
    if (list.length === 0 || position >= total) break;
  }
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 對單一地點執行同步：取得有權限人員，對入口/出口設備一致寫入或刪除
 * @param {number} locationId
 * @throws 地點未設定設備或 ISAPI 錯誤
 */
async function syncLocation(locationId) {
  const devs = await getPeopleCountingDevicesForLocation(locationId);
  if (!devs) throw createValidationError("該地點未設定人流門禁入口設備");

  const persons = await personnelService.getPersonsWithAccessByLocationId(locationId);
  const targetEmployeeNos = new Set(persons.map((p) => String(p.employee_no)));
  const targetList = persons.map((p) => ({ employeeNo: String(p.employee_no), name: p.full_name || p.employee_no }));

  const deviceIds = [devs.entryDeviceId];
  if (devs.exitDeviceId != null && devs.exitDeviceId !== devs.entryDeviceId) {
    deviceIds.push(devs.exitDeviceId);
  }

  for (const deviceId of deviceIds) {
    const currentEmployeeNos = new Set(await fetchAllEmployeeNosFromDevice(deviceId));
    const toAdd = targetList.filter((p) => !currentEmployeeNos.has(p.employeeNo));
    const toDelete = [...currentEmployeeNos].filter((no) => !targetEmployeeNos.has(no));

    for (const p of toAdd) {
      try {
        await accessControlService.updateUserInfo(deviceId, { employeeNo: p.employeeNo, name: p.name });
        await delay(SYNC_DELAY_MS);
      } catch (err) {
        logger.warn("ISAPI 新增人員失敗", { deviceId, employeeNo: p.employeeNo, error: err.message });
      }
    }

    if (toDelete.length > 0) {
      try {
        await accessControlService.deleteUserInfo(deviceId, { employeeNoList: toDelete });
        await delay(SYNC_DELAY_MS);
      } catch (err) {
        logger.warn("ISAPI 刪除人員失敗", { deviceId, count: toDelete.length, error: err.message });
      }
    }
  }

  logger.info("同步完成", { locationId });
}

/**
 * 對所有可同步地點依序執行同步
 * @returns {Promise<number[]>} 已同步的 locationId 列表
 */
async function syncAllLocations() {
  const locations = await getSyncableLocations();
  const synced = [];
  for (const loc of locations) {
    try {
      await syncLocation(loc.id);
      synced.push(loc.id);
    } catch (err) {
      logger.warn("同步地點失敗，跳過", { locationId: loc.id, error: err.message });
    }
  }
  return synced;
}

module.exports = {
  getPeopleCountingDevicesForLocation,
  getSyncableLocations,
  syncLocation,
  syncAllLocations,
};
