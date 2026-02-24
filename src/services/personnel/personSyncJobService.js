/**
 * 人員門禁同步服務（同步執行，無佇列）
 * 依 person_location_access 取得有權限人員，對地點綁定之入口/出口設備同步：新增、更新（姓名與人臉）、刪除。資料有更新即同步到設備。
 */
const path = require("path");
const fs = require("fs").promises;
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

function toMessage(err) {
  return err?.message ?? String(err);
}

/**
 * 取得地點的 people_counting 設定（entry/exit 門禁設備 ID）
 */
async function getPeopleCountingDevicesForLocation(locationId) {
  const rows = await db.query(
    "SELECT system_config FROM location_systems WHERE location_id = ? AND system_type = 'people_counting' LIMIT 1",
    [locationId],
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
 * 取得所有可同步的地點（people_counting 且具 entry_device_id）
 */
async function getSyncableLocations() {
  const rows = await db.query(
    `SELECT l.id, l.name, z.name AS zone_name
     FROM locations l
     INNER JOIN zones z ON l.zone_id = z.id
     INNER JOIN location_systems ls ON l.id = ls.location_id AND ls.system_type = 'people_counting'
     WHERE (ls.system_config->>'entry_device_id') IS NOT NULL AND (ls.system_config->>'entry_device_id') != ''
     ORDER BY z.name, l.name`,
    [],
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
    const res = await accessControlService.searchUserInfo(deviceId, {
      searchResultPosition: position,
      maxResults,
    });
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
 * 將 face_url 解析為圖片 Buffer
 * 支援：data:image/...;base64,xxx、/uploads/xxx、http(s) URL
 */
async function resolveFaceUrlToBuffer(faceUrl) {
  if (!faceUrl || typeof faceUrl !== "string") return null;
  const trimmed = faceUrl.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith("data:image") && trimmed.includes("base64,")) {
      const base64 = trimmed.split("base64,")[1];
      if (base64) return Buffer.from(base64, "base64");
    }
    if (trimmed.startsWith("/uploads/")) {
      const fullPath = path.join(process.cwd(), trimmed.replace(/^\//, ""));
      return await fs.readFile(fullPath);
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const res = await fetch(trimmed, { method: "GET" });
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
  } catch (err) {
    logger.warn("解析 face_url 失敗", { faceUrl: trimmed.substring(0, 50), error: err.message });
  }
  return null;
}

/**
 * 將單一人員的資料與人臉同步至設備（UserInfo + 人臉）；失敗時寫 log 並推入 warnings
 * @param {number} deviceId
 * @param {{ employeeNo: string, name: string, face_url: string|null }} person
 * @param {Array<{ type: string, employeeNo?: string, deviceId?: number, message: string }>} warnings
 */
async function syncPersonToDevice(deviceId, person, warnings) {
  await accessControlService.updateUserInfo(deviceId, {
    employeeNo: person.employeeNo,
    name: person.name,
  });
  await delay(SYNC_DELAY_MS);

  const imageBuffer = await resolveFaceUrlToBuffer(person.face_url);
  if (imageBuffer && imageBuffer.length > 0) {
    try {
      await accessControlService.updateFace(deviceId, person.employeeNo, imageBuffer);
      await delay(SYNC_DELAY_MS);
    } catch (faceErr) {
      const message = toMessage(faceErr);
      logger.warn("ISAPI 更新人臉失敗", { deviceId, employeeNo: person.employeeNo, error: message });
      warnings.push({ type: "face", employeeNo: person.employeeNo, deviceId, message });
    }
  }
}

/**
 * 對單一地點執行同步：目標名單為來源，設備與之對齊（新增/更新姓名與人臉、刪除多餘）
 * @returns {{ warnings: Array<{ type: string, employeeNo?: string, deviceId?: number, message: string }> }}
 */
async function syncLocation(locationId) {
  const warnings = [];
  const devs = await getPeopleCountingDevicesForLocation(locationId);
  if (!devs) throw createValidationError("該地點未設定人流門禁入口設備");

  const persons = await personnelService.getPersonsWithAccessByLocationId(locationId);
  const targetEmployeeNos = new Set(persons.map((p) => String(p.employee_no)));
  const targetList = persons.map((p) => ({
    employeeNo: String(p.employee_no),
    name: p.full_name || p.employee_no,
    face_url: p.face_url || null,
  }));

  const deviceIds = [devs.entryDeviceId];
  if (devs.exitDeviceId != null && devs.exitDeviceId !== devs.entryDeviceId) {
    deviceIds.push(devs.exitDeviceId);
  }

  for (const deviceId of deviceIds) {
    const currentEmployeeNos = new Set(await fetchAllEmployeeNosFromDevice(deviceId));

    const toSync = targetList.filter((p) => currentEmployeeNos.has(p.employeeNo));
    const toAdd = targetList.filter((p) => !currentEmployeeNos.has(p.employeeNo));
    const toDelete = [...currentEmployeeNos].filter((no) => !targetEmployeeNos.has(no));

    for (const p of toAdd) {
      try {
        await syncPersonToDevice(deviceId, p, warnings);
      } catch (err) {
        const message = toMessage(err);
        logger.warn("ISAPI 新增人員失敗", { deviceId, employeeNo: p.employeeNo, error: message });
        warnings.push({ type: "add", employeeNo: p.employeeNo, deviceId, message });
      }
    }

    for (const p of toSync) {
      try {
        await syncPersonToDevice(deviceId, p, warnings);
      } catch (err) {
        const message = toMessage(err);
        logger.warn("ISAPI 更新人員失敗", { deviceId, employeeNo: p.employeeNo, error: message });
        warnings.push({ type: "update", employeeNo: p.employeeNo, deviceId, message });
      }
    }

    if (toDelete.length > 0) {
      try {
        await accessControlService.deleteUserInfo(deviceId, { employeeNoList: toDelete });
        await delay(SYNC_DELAY_MS);
      } catch (err) {
        const message = toMessage(err);
        logger.warn("ISAPI 刪除人員失敗", { deviceId, count: toDelete.length, error: message });
        warnings.push({ type: "delete", deviceId, message });
      }
    }
  }

  logger.info("同步完成", { locationId, warningsCount: warnings.length });
  return { warnings };
}

/**
 * 對所有可同步地點依序執行同步
 * @returns {Promise<{ synced: number, results: Array<{ locationId: number, locationName?: string, warnings: Array }> }>}
 */
async function syncAllLocations() {
  const locations = await getSyncableLocations();
  const results = [];
  for (const loc of locations) {
    try {
      const { warnings } = await syncLocation(loc.id);
      results.push({ locationId: loc.id, locationName: loc.name, warnings });
    } catch (err) {
      const message = toMessage(err);
      logger.warn("同步地點失敗，跳過", { locationId: loc.id, error: message });
      results.push({
        locationId: loc.id,
        locationName: loc.name,
        warnings: [{ type: "sync", message }],
      });
    }
  }
  return { synced: results.length, results };
}

module.exports = {
  getPeopleCountingDevicesForLocation,
  getSyncableLocations,
  syncLocation,
  syncAllLocations,
};
