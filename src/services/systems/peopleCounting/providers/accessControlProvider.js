/**
 * 門禁（access_control）人流統計 Provider
 * 實作 getSiteData、getSiteLogs、getUnitPersonnel；資料來源為本系統 persons、isapi_access_events。
 */

const db = require("../../../../database/db");
const deviceService = require("../../../devices/deviceService");
const personnelService = require("../../../personnel/personnelService");
const { getTodayTimeRange } = require("../../../../utils/dateRangeUtils");
const logger = require("../../../../utils/logger");

function normalizeDeviceHost(host) {
  if (!host || typeof host !== "string") return "";
  const trimmed = host.trim();
  const m = trimmed.match(/^(?:https?:\/\/)?([^:/]+)/);
  return m ? m[1] : trimmed;
}

/**
 * 從門禁進出紀錄計算今日進場/出場/在場人數
 */
function calculateEntryExitCurrentFromAccessControlLogs(logs) {
  if (!logs || logs.length === 0) {
    return { entryCount: 0, exitCount: 0, currentCount: 0 };
  }
  const sorted = [...logs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const lastByPerson = new Map();
  let entryCount = 0;
  let exitCount = 0;
  for (const log of sorted) {
    const key = log.employeeId || "";
    if (!key || log.eventType === "failed") continue;
    const dir =
      log.eventType === "entry" || log.eventType === "exit"
        ? log.eventType
        : null;
    if (!dir) continue;
    const prev = lastByPerson.get(key);
    if (prev === undefined && dir === "exit") continue;
    if (prev !== dir) {
      if (dir === "entry") entryCount++;
      else exitCount++;
    }
    lastByPerson.set(key, dir);
  }
  const currentCount = [...lastByPerson.values()].filter(
    (d) => d === "entry",
  ).length;
  return { entryCount, exitCount, currentCount };
}

function currentCountFromAccessControlLogs(logs) {
  return calculateEntryExitCurrentFromAccessControlLogs(logs).currentCount;
}

/**
 * 門禁地點進出紀錄：從 isapi_access_events 查詢
 */
async function getAccessControlSiteLogs(siteId, options = {}) {
  const {
    entryDeviceIds,
    exitDeviceIds,
    limit = 50,
    offset = 0,
    startTime: optStart,
    endTime: optEnd,
  } = options;

  const entryIds = Array.isArray(entryDeviceIds)
    ? entryDeviceIds
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const exitIds = Array.isArray(exitDeviceIds)
    ? exitDeviceIds
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (entryIds.length === 0 && exitIds.length === 0) return [];

  const entryIps = new Set();
  const exitIps = new Set();
  const allIps = new Set();
  const ipToDeviceName = new Map();

  const addDevice = async (deviceId, isEntry) => {
    try {
      const { device } = await deviceService.getDeviceById(deviceId);
      const host = device?.config?.host;
      const ip = normalizeDeviceHost(host);
      if (ip) {
        allIps.add(ip);
        ipToDeviceName.set(ip, device?.name || ip);
        if (isEntry) entryIps.add(ip);
        else exitIps.add(ip);
      }
    } catch (err) {
      logger.warn("取得門禁設備 IP 失敗，略過", {
        deviceId,
        error: err.message,
      });
    }
  };

  const entryIdSet = new Set(entryIds);
  for (const id of entryIdSet) await addDevice(id, true);
  for (const id of new Set(exitIds)) {
    if (!entryIdSet.has(id)) await addDevice(id, false);
  }
  const allIpsArray = [...allIps];
  if (allIpsArray.length === 0) return [];

  const start = optStart ? new Date(optStart) : getTodayTimeRange().start;
  const end = optEnd ? new Date(optEnd) : getTodayTimeRange().end;
  const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offsetNum = Math.max(Number(offset) || 0, 0);

  const placeholders = allIpsArray.map(() => "?").join(",");
  const params = [
    ...allIpsArray,
    start.toISOString(),
    end.toISOString(),
    limitNum,
    offsetNum,
  ];
  const rows = await db.query(
    `SELECT id, device_ip, event_time, event_type, payload, picture_path
     FROM isapi_access_events
     WHERE device_ip IN (${placeholders}) AND event_time >= ? AND event_time <= ?
     ORDER BY event_time DESC
     LIMIT ? OFFSET ?`,
    params,
  );

  const getEmployeeNo = (payload) => {
    const v = payload.employeeNoString ?? payload.employeeNo;
    return v != null ? String(v).trim() : "";
  };
  const employeeNos = [
    ...new Set(
      (rows || [])
        .map((r) =>
          getEmployeeNo(typeof r.payload === "object" ? r.payload : {}),
        )
        .filter(Boolean),
    ),
  ];

  const personByEmployeeNo = new Map();
  if (employeeNos.length > 0) {
    const placeholdersPerson = employeeNos.map(() => "?").join(",");
    const personRows = await db.query(
      `SELECT p.id, p.employee_no, p.full_name, p.person_group_id, pg.name AS unit_name
       FROM persons p
       LEFT JOIN person_groups pg ON p.person_group_id = pg.id
       WHERE p.employee_no IN (${placeholdersPerson})`,
      employeeNos,
    );
    for (const r of personRows || []) {
      const no = r.employee_no != null ? String(r.employee_no).trim() : "";
      if (no) {
        personByEmployeeNo.set(no, {
          personId: r.id,
          personName: r.full_name != null ? String(r.full_name).trim() : "",
          unitId: r.person_group_id != null ? Number(r.person_group_id) : null,
          unitName: r.unit_name != null ? String(r.unit_name).trim() : "",
        });
      }
    }
  }

  return (rows || []).map((row) => {
    const payload = typeof row.payload === "object" ? row.payload : {};
    const sub =
      payload.subEventType != null ? Number(payload.subEventType) : null;
    const eventType =
      sub === 9 || sub === 39 || sub === 76 || sub === 2078 || sub === 2079
        ? "failed"
        : entryIps.has(row.device_ip)
          ? "entry"
          : exitIps.has(row.device_ip)
            ? "exit"
            : "entry";
    const employeeId = getEmployeeNo(payload);
    const personInfo = employeeId ? personByEmployeeNo.get(employeeId) : null;
    const devicePersonName =
      payload.personName != null ? String(payload.personName).trim() : "";
    return {
      id: `isapi-${row.id}`,
      personId: personInfo?.personId ?? null,
      personName: personInfo?.personName || devicePersonName || "—",
      unitId: personInfo?.unitId ?? null,
      unitName: personInfo?.unitName ?? "",
      employeeId: employeeId || null,
      eventType,
      timestamp: row.event_time,
      deviceScreenshotUrl: row.picture_path || "",
      deviceName: ipToDeviceName.get(row.device_ip) || row.device_ip,
    };
  });
}

/**
 * 單一工地完整資料（統計 + 單位列表）
 */
async function getSiteData(siteId, config) {
  const entryDeviceIds = Array.isArray(config.entryDeviceIds)
    ? config.entryDeviceIds
    : [];
  const exitDeviceIds = Array.isArray(config.exitDeviceIds)
    ? config.exitDeviceIds
    : [];
  let units = [];
  let entryCount = 0;
  let exitCount = 0;
  let currentCount = 0;
  try {
    const persons =
      await personnelService.getPersonsWithAccessByLocationId(siteId);
    const byGroup = new Map();
    for (const p of persons) {
      const gname = p.group_name || "未分組";
      if (!byGroup.has(gname)) byGroup.set(gname, []);
      byGroup.get(gname).push(p);
    }
    const { start, end } = getTodayTimeRange();
    const todayLogs =
      entryDeviceIds.length > 0 || exitDeviceIds.length > 0
        ? await getAccessControlSiteLogs(siteId, {
            entryDeviceIds,
            exitDeviceIds,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            limit: 2000,
            offset: 0,
          })
        : [];
    const siteStats = calculateEntryExitCurrentFromAccessControlLogs(todayLogs);
    entryCount = siteStats.entryCount;
    exitCount = siteStats.exitCount;
    currentCount = siteStats.currentCount;
    let idx = 0;
    units = [...byGroup.entries()].map(([name, list]) => {
      const employeeNos = new Set(list.map((p) => String(p.employee_no)));
      const unitLogs = todayLogs.filter((log) =>
        employeeNos.has(log.employeeId || ""),
      );
      return {
        id: ++idx,
        name,
        currentCount: currentCountFromAccessControlLogs(unitLogs),
        totalCount: list.length,
      };
    });
  } catch (err) {
    logger.warn("取得門禁地點可進出人員失敗，顯示空單位", {
      locationId: siteId,
      error: err.message,
    });
  }
  return { entryCount, exitCount, currentCount, units };
}

/**
 * 進出紀錄
 */
async function getSiteLogs(siteId, config, options = {}) {
  const accessControlLogs = await getAccessControlSiteLogs(siteId, {
    entryDeviceIds: config.entryDeviceIds,
    exitDeviceIds: config.exitDeviceIds,
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
    startTime: options.startTime,
    endTime: options.endTime,
  });
  return { logs: accessControlLogs };
}

/**
 * 單位人員列表（門禁：unitId 為群組序號 1-based）
 */
async function getUnitPersonnel(unitId, siteId, config) {
  const persons =
    await personnelService.getPersonsWithAccessByLocationId(siteId);
  const byGroup = new Map();
  for (const p of persons) {
    const gname = p.group_name || "未分組";
    if (!byGroup.has(gname)) byGroup.set(gname, []);
    byGroup.get(gname).push(p);
  }
  const groupList = [...byGroup.entries()];
  const idx = Math.max(0, Number(unitId) - 1);
  const group = groupList[idx];
  if (!group) return { personnel: [], entryCount: 0, exitCount: 0 };
  const [, list] = group;
  const employeeNosInUnit = new Set(list.map((p) => String(p.employee_no)));

  const { start: todayStart, end: todayEnd } = getTodayTimeRange();
  const todayLogs = await getAccessControlSiteLogs(siteId, {
    entryDeviceIds: config.entryDeviceIds,
    exitDeviceIds: config.exitDeviceIds,
    startTime: todayStart.toISOString(),
    endTime: todayEnd.toISOString(),
    limit: 500,
    offset: 0,
  });
  const entryCount = todayLogs.filter(
    (log) =>
      log.eventType === "entry" && employeeNosInUnit.has(log.employeeId || ""),
  ).length;
  const exitCount = todayLogs.filter(
    (log) =>
      log.eventType === "exit" && employeeNosInUnit.has(log.employeeId || ""),
  ).length;

  const lastEntryByNo = new Map();
  const lastExitByNo = new Map();
  for (const log of todayLogs) {
    const no = log.employeeId || "";
    if (!employeeNosInUnit.has(no)) continue;
    const ts = log.timestamp;
    if (log.eventType === "entry" && !lastEntryByNo.has(no))
      lastEntryByNo.set(no, ts);
    if (log.eventType === "exit" && !lastExitByNo.has(no))
      lastExitByNo.set(no, ts);
  }

  const personnel = list.map((p) => {
    const no = String(p.employee_no);
    const lastEntry = lastEntryByNo.get(no);
    const lastExit = lastExitByNo.get(no);
    const entryDate = lastEntry ? new Date(lastEntry) : null;
    const exitDate = lastExit ? new Date(lastExit) : null;
    const isPresent =
      lastEntry && (!lastExit || new Date(lastExit) < new Date(lastEntry));
    const isTodayEntry =
      entryDate && entryDate >= todayStart && entryDate <= todayEnd;
    const faceUrl = p.face_url != null ? String(p.face_url).trim() : "";
    const photoUrl =
      faceUrl !== ""
        ? faceUrl.startsWith("/")
          ? faceUrl
          : `/${faceUrl}`
        : undefined;
    return {
      id: p.id,
      unitId: p.person_group_id || 0,
      employeeId: no,
      name: p.full_name || p.employee_no || "",
      photoUrl,
      isPresent: !!isPresent,
      lastEntryTime: lastEntry || null,
      lastExitTime: lastExit || null,
      lastEntryDate: entryDate ? entryDate.toISOString().slice(0, 10) : null,
      entryTime: entryDate ? entryDate.toTimeString().slice(0, 8) : null,
      exitTime: exitDate ? exitDate.toTimeString().slice(0, 8) : null,
      isTodayEntry: !!isTodayEntry,
    };
  });
  return { personnel, entryCount, exitCount };
}

module.exports = {
  getSiteData,
  getSiteLogs,
  getUnitPersonnel,
};
