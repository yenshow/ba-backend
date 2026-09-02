/**
 * ISAPI 攝影機（isapi_camera）人流統計 Provider
 *
 * cameraMode：
 * - people_counting：units＝設備分區（Area）進／出；logs＝PeopleCounting 分區 delta
 * - face_recognition：units＝地點名單 person_groups；logs＝isapi_face_contrast_events；
 *   方向由 entryCameraDeviceIds／exitCameraDeviceIds 決定
 */
const db = require("../../../database/db");
const personnelService = require("../../personnel/personnelService");
const logger = require("../../../utils/logger").createLogger(
  "ISAPI Camera PeopleCounting",
);
const {
  computeCumulativeStats,
  computeTransitionStats,
  sumCumulativeParts,
  resolvePersonPresenceFromEvents,
} = require("../../entryExit/stats");
const {
  personnelPresenceFields,
  ISO_PERSONNEL_TIME_FORMAT,
  groupEventsByKey,
  normalizeEmployeeNo,
} = require("../helpers/entryExitStats");
const {
  ENTRY_EXIT_MAX_RECORDS,
} = require("../../entryExit/resolveTimeOptions");
const {
  resolvePeopleCountingStatsTimeRange,
  isStatsResetActive,
  isFaceRecognitionCameraMode,
  resolvePeopleCountingCameraDevices,
  resolveFaceCameraDirection,
  normalizeFaceSimilarityThreshold,
} = require("../peopleCountingConfig");
const C = require("../../../utils/apiErrorCodes");
const { throwApiError } = require("../../../utils/apiErrors");
const { ensureIntArray } = require("../../location/locationShared");

function ensureInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 分區名稱 → 穩定 id（人流統計模式 units） */
function stableUnitIdFromName(name) {
  const s = String(name || "").trim();
  if (!s) return 0;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0) % 2147483647;
}

const UNGROUPED_GROUP_ID = 0;
const UNGROUPED_GROUP_NAME = "未分組";

function groupPersonsByPersonGroup(persons) {
  const byGroupId = new Map();
  for (const p of persons || []) {
    const groupId =
      p.person_group_id != null && Number.isFinite(Number(p.person_group_id))
        ? Number(p.person_group_id)
        : UNGROUPED_GROUP_ID;
    const groupName =
      groupId === UNGROUPED_GROUP_ID
        ? UNGROUPED_GROUP_NAME
        : p.group_name || UNGROUPED_GROUP_NAME;
    if (!byGroupId.has(groupId)) {
      byGroupId.set(groupId, { id: groupId, name: groupName, list: [] });
    }
    byGroupId.get(groupId).list.push(p);
  }
  return [...byGroupId.values()].sort((a, b) => {
    if (a.id === UNGROUPED_GROUP_ID) return 1;
    if (b.id === UNGROUPED_GROUP_ID) return -1;
    return String(a.name).localeCompare(String(b.name), "zh-Hant");
  });
}

function resolvePhotoUrl(person) {
  const faceUrl = person.face_url != null ? String(person.face_url).trim() : "";
  if (faceUrl === "") return undefined;
  return faceUrl.startsWith("/") ? faceUrl : `/${faceUrl}`;
}

async function buildRosterUnits(siteId, directedRows = []) {
  try {
    const persons =
      await personnelService.getPersonsWithAccessByLocationId(siteId);
    const grouped = groupPersonsByPersonGroup(persons);
    const presenceByEmployeeNo = buildFacePresenceByEmployeeNo(directedRows);
    return grouped.map((group) => {
      const unitNos = new Set(
        group.list
          .map((p) => normalizeEmployeeNo(p.employee_no))
          .filter(Boolean),
      );
      const unitEvents = (directedRows || []).filter((r) =>
        unitNos.has(normalizeEmployeeNo(r.employee_no)),
      );
      const stats = computeTransitionStats(unitEvents, {
        getKey: (r) => facePersonKey(r),
        getDirection: (r) =>
          r.direction === "entry" || r.direction === "exit"
            ? r.direction
            : null,
        getTime: (r) => r.event_time,
        sortByTime: false,
      });
      let currentCount = 0;
      for (const p of group.list) {
        const no = p.employee_no != null ? String(p.employee_no).trim() : "";
        if (no && presenceByEmployeeNo.get(no)?.isInside) currentCount += 1;
      }
      return {
        id: group.id,
        name: group.name,
        currentCount,
        entryCount: stats.entryCount,
        exitCount: stats.exitCount,
        totalCount: group.list.length,
      };
    });
  } catch (err) {
    logger.warn("取得攝影機地點名單群組失敗，顯示空單位", {
      locationId: siteId,
      error: err?.message || String(err),
    });
    return [];
  }
}

function buildRegionUnitsFromDeltaMap(byRegion) {
  const sortedNames = [...byRegion.keys()].sort((a, b) =>
    a.localeCompare(b, "zh-Hant"),
  );
  return sortedNames.map((name, idx) => {
    const { enter, exit } = byRegion.get(name);
    const unitStats = computeCumulativeStats(enter, exit);
    return {
      id: stableUnitIdFromName(name) || idx + 1,
      name,
      currentCount: unitStats.currentCount,
      entryCount: unitStats.entryCount,
      exitCount: unitStats.exitCount,
      totalCount: Math.max(0, enter),
    };
  });
}

function buildRegionUnitsFromLatestRows(regionRows) {
  const sorted = [...regionRows].sort((a, b) =>
    String(a.region_name || "").localeCompare(
      String(b.region_name || ""),
      "zh-Hant",
    ),
  );
  return sorted.map((r, idx) => {
    const ent = ensureInt(r.enter) ?? 0;
    const ex = ensureInt(r.exit) ?? 0;
    const unitStats = computeCumulativeStats(ent, ex);
    const name = String(r.region_name || "").trim() || "未命名區域";
    return {
      id: stableUnitIdFromName(name) || idx + 1,
      name,
      currentCount: unitStats.currentCount,
      entryCount: unitStats.entryCount,
      exitCount: unitStats.exitCount,
      totalCount: Math.max(0, ent),
    };
  });
}

async function getSiteConfigOrThrow(siteId, config) {
  const cameras = resolvePeopleCountingCameraDevices(config);
  const deviceIds = cameras.cameraDeviceIds;
  if (deviceIds.length === 0) {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      isFaceRecognitionCameraMode(config.cameraMode)
        ? "未設定進場／出場攝影機"
        : "未設定攝影機設備（cameraDeviceIds）",
    );
  }
  const channelId = 1;
  return { deviceIds, channelId, cameras };
}

async function getLatestRegionTotalsByName(
  siteId,
  deviceIds,
  channelId,
  eventTimeRange,
) {
  const { start, end } = eventTimeRange;
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const rows = await db.query(
    `SELECT e.device_id, e.region_id, e.region_name, e.enter, e."exit", e.event_time
     FROM (
       SELECT DISTINCT device_id, region_name
       FROM isapi_people_counting_events
       WHERE location_id = ?
         AND device_id = ANY(?::int[])
         AND channel_id = ?
         AND region_id IS NOT NULL
         AND region_name IS NOT NULL
         AND region_name != ''
         AND event_time >= ?
         AND event_time <= ?
     ) d
     JOIN LATERAL (
       SELECT device_id, region_id, region_name, enter, "exit", event_time
       FROM isapi_people_counting_events e
       WHERE e.location_id = ?
         AND e.device_id = d.device_id
         AND e.channel_id = ?
         AND e.region_id IS NOT NULL
         AND e.region_name = d.region_name
         AND e.event_time >= ?
         AND e.event_time <= ?
       ORDER BY e.event_time DESC
       LIMIT 1
     ) e ON true`,
    [
      siteId,
      deviceIds,
      channelId,
      startIso,
      endIso,
      siteId,
      channelId,
      startIso,
      endIso,
    ],
  );
  return Array.isArray(rows) ? rows : [];
}

async function getStatsFromDeltasByRegion(
  siteId,
  deviceIds,
  channelId,
  eventTimeRange,
) {
  const { start, end } = eventTimeRange;
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const rows = await db.query(
    `SELECT region_name, enter_delta, exit_delta
     FROM isapi_people_counting_events
     WHERE location_id = ?
       AND device_id = ANY(?::int[])
       AND channel_id = ?
       AND region_id IS NOT NULL
       AND region_name IS NOT NULL
       AND region_name != ''
       AND event_time >= ?
       AND event_time <= ?`,
    [siteId, deviceIds, channelId, startIso, endIso],
  );
  const byRegion = new Map();
  for (const r of rows || []) {
    const name = String(r.region_name || "").trim() || "未命名區域";
    if (!byRegion.has(name)) {
      byRegion.set(name, { enter: 0, exit: 0 });
    }
    const agg = byRegion.get(name);
    agg.enter += ensureInt(r.enter_delta) ?? 0;
    agg.exit += ensureInt(r.exit_delta) ?? 0;
  }
  return byRegion;
}

async function loadRegionUnitsAndTotals(siteId, deviceIds, channelId, config) {
  const today = resolvePeopleCountingStatsTimeRange({}, config.statsResetAt);
  let units = [];

  if (isStatsResetActive(config.statsResetAt)) {
    const byRegion = await getStatsFromDeltasByRegion(
      siteId,
      deviceIds,
      channelId,
      today,
    );
    units = buildRegionUnitsFromDeltaMap(byRegion);
  } else {
    const regionRows = await getLatestRegionTotalsByName(
      siteId,
      deviceIds,
      channelId,
      today,
    );
    if (regionRows.length > 0) {
      units = buildRegionUnitsFromLatestRows(regionRows);
    }
  }

  const totals = sumCumulativeParts(units);
  return { units, totals };
}

async function getSiteData(siteId, config) {
  const { deviceIds, channelId, cameras } = await getSiteConfigOrThrow(
    siteId,
    config,
  );

  if (isFaceRecognitionCameraMode(config.cameraMode)) {
    const today = resolvePeopleCountingStatsTimeRange({}, config.statsResetAt);
    const directed = await loadGatedDirectedFaceRows(
      siteId,
      deviceIds,
      today,
      config,
      cameras,
    );
    const siteStats = computeTransitionStats(directed, {
      getKey: (r) => facePersonKey(r),
      getDirection: (r) =>
        r.direction === "entry" || r.direction === "exit" ? r.direction : null,
      getTime: (r) => r.event_time,
      sortByTime: false,
    });
    const units = await buildRosterUnits(siteId, directed);
    return {
      entryCount: siteStats.entryCount,
      exitCount: siteStats.exitCount,
      currentCount: siteStats.currentCount,
      units,
    };
  }

  const { units: regionUnits, totals } = await loadRegionUnitsAndTotals(
    siteId,
    deviceIds,
    channelId,
    config,
  );

  return {
    entryCount: totals.entryCount,
    exitCount: totals.exitCount,
    currentCount: totals.currentCount,
    units: regionUnits,
  };
}

async function loadDeviceNameById(deviceIds) {
  const deviceNameById = new Map();
  try {
    const deviceRows = await db.query(
      `SELECT id, name FROM devices WHERE id = ANY(?::int[])`,
      [deviceIds],
    );
    for (const r of deviceRows || []) {
      if (r?.id != null) {
        deviceNameById.set(Number(r.id), String(r.name || "").trim());
      }
    }
  } catch {
    // ignore: fallback to IP
  }
  return deviceNameById;
}

/**
 * 人臉辨識模式：進出紀錄改讀 isapi_face_contrast_events（欄位語意同門禁）
 */
async function getFaceContrastSiteLogs(siteId, deviceIds, options = {}) {
  const { start, end } = resolvePeopleCountingStatsTimeRange(
    options,
    options.statsResetAt,
  );
  const limit = Math.min(
    Math.max(Number(options.limit) || 50, 1),
    ENTRY_EXIT_MAX_RECORDS,
  );
  const offset = Math.max(Number(options.offset) || 0, 0);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const deviceNameById = await loadDeviceNameById(deviceIds);
  const cameras = options.cameras || {
    entryCameraDeviceIds: [],
    exitCameraDeviceIds: [],
  };

  const threshold = normalizeFaceSimilarityThreshold(
    options.faceSimilarityThreshold,
  );

  const allRows = await db.query(
    `SELECT
       e.id, e.device_id, e.device_ip, e.event_time, e.similarity,
       e.employee_no, e.person_name, e.matched, e.pid, e.payload,
       e.picture_path,
       p.id AS person_id, p.full_name AS platform_name,
       p.person_group_id, pg.name AS group_name
     FROM isapi_face_contrast_events e
     LEFT JOIN persons p
       ON p.employee_no IS NOT NULL
      AND e.employee_no IS NOT NULL
      AND TRIM(p.employee_no) = TRIM(e.employee_no)
     LEFT JOIN person_groups pg ON p.person_group_id = pg.id
     WHERE e.location_id = ?
       AND e.device_id = ANY(?::int[])
       AND e.event_time >= ?
       AND e.event_time <= ?
     ORDER BY e.event_time ASC, e.id ASC`,
    [siteId, deviceIds, startIso, endIso],
  );

  const gated = applyFaceSimilarityGate(allRows || [], threshold);
  const directed = assignFaceDirections(gated, cameras);
  const total = directed.length;
  const page = directed
    .slice()
    .reverse()
    .slice(offset, offset + limit);

  const logs = page.map((r) => {
    const matched = Boolean(r.matched);
    const deviceName =
      deviceNameById.get(ensureInt(r.device_id)) || r.device_ip || "";
    const personName =
      (r.platform_name != null ? String(r.platform_name).trim() : "") ||
      (r.person_name != null ? String(r.person_name).trim() : "") ||
      "—";
    const direction =
      r.direction === "entry" || r.direction === "exit" ? r.direction : null;
    const eventType = !matched
      ? "failed"
      : direction === "exit"
        ? "exit"
        : direction === "entry"
          ? "entry"
          : "failed";
    const similarity =
      r.similarity != null && Number.isFinite(Number(r.similarity))
        ? Number(r.similarity)
        : null;
    return {
      id: `fc-cam-${r.id}`,
      personId: r.person_id != null ? Number(r.person_id) : null,
      personName,
      unitId: r.person_group_id != null ? Number(r.person_group_id) : null,
      unitName: r.group_name != null ? String(r.group_name).trim() : "",
      employeeId:
        r.employee_no != null && String(r.employee_no).trim()
          ? String(r.employee_no).trim()
          : null,
      eventType,
      eventLabel:
        eventType === "entry" ? "進入" : eventType === "exit" ? "離開" : "失敗",
      verifyMethod: "人臉",
      similarity,
      timestamp: r.event_time,
      deviceScreenshotUrl:
        r.picture_path != null ? String(r.picture_path).trim() : "",
      deviceName,
    };
  });

  return { logs, total };
}

function facePersonKey(r) {
  const no =
    r.employee_no != null && String(r.employee_no).trim()
      ? String(r.employee_no).trim()
      : "";
  if (no) return no;
  const name =
    r.person_name != null && String(r.person_name).trim()
      ? String(r.person_name).trim()
      : "";
  return name ? `name:${name}` : "";
}

/** 依地點準確度下限：未達標視同 matched=false（仍保留 similarity 供顯示） */
function applyFaceSimilarityGate(rows, threshold) {
  const t = normalizeFaceSimilarityThreshold(threshold);
  return (rows || []).map((r) => {
    if (r.matched === false) return r;
    const s = Number(r.similarity);
    if (!Number.isFinite(s) || s < t) return { ...r, matched: false };
    return r;
  });
}

async function loadGatedDirectedFaceRows(
  siteId,
  deviceIds,
  eventTimeRange,
  config,
  cameras,
) {
  const rows = await loadTodayFaceContrastRows(siteId, deviceIds, eventTimeRange);
  const gated = applyFaceSimilarityGate(rows, config.faceSimilarityThreshold);
  return assignFaceDirections(gated, cameras);
}

function readStoredDirection(payload) {
  const p =
    payload && typeof payload === "object"
      ? payload
      : typeof payload === "string"
        ? (() => {
            try {
              return JSON.parse(payload);
            } catch {
              return null;
            }
          })()
        : null;
  const d = p?.direction;
  return d === "entry" || d === "exit" ? d : null;
}

/**
 * 標註進出：優先依目前進／出場攝影機歸屬；其次用落地 payload.direction（舊交替資料）
 */
function assignFaceDirections(rowsAsc, cameras) {
  return (rowsAsc || []).map((r) => {
    if (r.matched === false) return { ...r, direction: null };
    const byDevice = resolveFaceCameraDirection(r.device_id, cameras);
    if (byDevice) return { ...r, direction: byDevice };
    const stored = readStoredDirection(r.payload);
    return { ...r, direction: stored };
  });
}

async function loadTodayFaceContrastRows(siteId, deviceIds, eventTimeRange) {
  const startIso = eventTimeRange.start.toISOString();
  const endIso = eventTimeRange.end.toISOString();
  const rows = await db.query(
    `SELECT employee_no, person_name, matched, similarity, event_time, payload, device_id
     FROM isapi_face_contrast_events
     WHERE location_id = ?
       AND device_id = ANY(?::int[])
       AND event_time >= ?
       AND event_time <= ?
     ORDER BY event_time ASC, id ASC`,
    [siteId, deviceIds, startIso, endIso],
  );
  return Array.isArray(rows) ? rows : [];
}

function buildFacePresenceByEmployeeNo(directedRows) {
  const byNo = groupEventsByKey(
    (directedRows || []).filter((r) => normalizeEmployeeNo(r.employee_no)),
    (r) => normalizeEmployeeNo(r.employee_no),
  );
  const map = new Map();
  for (const [no, events] of byNo.entries()) {
    map.set(
      no,
      resolvePersonPresenceFromEvents(events, {
        getDirection: (e) =>
          e.direction === "entry" || e.direction === "exit"
            ? e.direction
            : null,
        getTime: (e) => e.event_time,
        sortByTime: false,
      }),
    );
  }
  return map;
}

async function getSiteLogs(siteId, config, options = {}) {
  const { deviceIds, channelId, cameras } = await getSiteConfigOrThrow(
    siteId,
    config,
  );
  if (isFaceRecognitionCameraMode(config.cameraMode)) {
    return getFaceContrastSiteLogs(siteId, deviceIds, {
      ...options,
      statsResetAt: config.statsResetAt,
      faceSimilarityThreshold: config.faceSimilarityThreshold,
      cameras,
    });
  }

  const { start, end } = resolvePeopleCountingStatsTimeRange(
    options,
    config.statsResetAt,
  );
  const limit = Math.min(
    Math.max(Number(options.limit) || 50, 1),
    ENTRY_EXIT_MAX_RECORDS,
  );
  const offset = Math.max(Number(options.offset) || 0, 0);

  const deviceNameById = await loadDeviceNameById(deviceIds);

  const regionFilterSql = "AND region_id IS NOT NULL";
  const unitIdFilter = ensureInt(options.unitId);

  const toEvent = (row, eventType, unitName) => {
    const suffix = eventType === "entry" ? "in" : "out";
    const eventLabel = eventType === "entry" ? "進入" : "離開";
    const deviceName =
      deviceNameById.get(ensureInt(row.device_id)) || row.device_ip || "";
    return {
      id: `pc-cam-${row.id}-${suffix}`,
      personId: -1,
      personName: "—",
      unitId:
        unitIdFilter != null
          ? unitIdFilter
          : stableUnitIdFromName(unitName) || null,
      unitName,
      employeeId: null,
      eventType,
      eventLabel,
      verifyMethod: null,
      timestamp: row.event_time,
      deviceScreenshotUrl: "",
      deviceName,
    };
  };

  const events = [];
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const batchSize = Math.min(Math.max(limit * 10, 50), 1000);
  let rowOffset = offset;

  const countRows = await db.query(
    `SELECT COALESCE(SUM(
       CASE WHEN enter_delta > 0 THEN 1 ELSE 0 END +
       CASE WHEN exit_delta > 0 THEN 1 ELSE 0 END
     ), 0)::int AS cnt
     FROM isapi_people_counting_events
     WHERE location_id = ?
       AND device_id = ANY(?::int[])
       AND channel_id = ?
       ${regionFilterSql}
       AND event_time >= ?
       AND event_time <= ?`,
    [siteId, deviceIds, channelId, startIso, endIso],
  );
  const total = Number(countRows?.[0]?.cnt) || 0;

  while (events.length < limit) {
    const rows = await db.query(
      `SELECT id, region_id, region_name, event_time, enter_delta, exit_delta, device_id, device_ip
       FROM isapi_people_counting_events
       WHERE location_id = ?
         AND device_id = ANY(?::int[])
         AND channel_id = ?
         ${regionFilterSql}
         AND event_time >= ?
         AND event_time <= ?
       ORDER BY event_time DESC, id DESC
       LIMIT ? OFFSET ?`,
      [siteId, deviceIds, channelId, startIso, endIso, batchSize, rowOffset],
    );

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      if (events.length >= limit) break;

      const enterDelta = ensureInt(r.enter_delta) ?? 0;
      const exitDelta = ensureInt(r.exit_delta) ?? 0;
      const unitName = String(r.region_name || "").trim() || "未命名區域";

      if (
        unitIdFilter != null &&
        unitIdFilter !== 0 &&
        stableUnitIdFromName(unitName) !== unitIdFilter
      ) {
        continue;
      }

      if (enterDelta > 0) events.push(toEvent(r, "entry", unitName));
      if (events.length >= limit) break;
      if (exitDelta > 0) events.push(toEvent(r, "exit", unitName));
    }

    if (rows.length < batchSize) break;
    rowOffset += rows.length;
  }

  return { logs: events.slice(0, limit), total };
}

async function getUnitPersonnel(unitId, siteId, config) {
  if (!isFaceRecognitionCameraMode(config?.cameraMode)) {
    return { personnel: [], entryCount: 0, exitCount: 0 };
  }

  const { deviceIds, cameras } = await getSiteConfigOrThrow(siteId, config);
  const today = resolvePeopleCountingStatsTimeRange({}, config.statsResetAt);
  const directed = await loadGatedDirectedFaceRows(
    siteId,
    deviceIds,
    today,
    config,
    cameras,
  );
  const presenceByEmployeeNo = buildFacePresenceByEmployeeNo(directed);

  const persons =
    await personnelService.getPersonsWithAccessByLocationId(siteId);
  const grouped = groupPersonsByPersonGroup(persons);
  const match = grouped.find((g) => g.id === Number(unitId));
  if (!match) return { personnel: [], entryCount: 0, exitCount: 0 };

  const unitNos = new Set(
    match.list.map((p) => normalizeEmployeeNo(p.employee_no)).filter(Boolean),
  );
  const unitEvents = directed.filter((r) =>
    unitNos.has(normalizeEmployeeNo(r.employee_no)),
  );
  const { entryCount, exitCount } = computeTransitionStats(unitEvents, {
    getKey: (r) => facePersonKey(r),
    getDirection: (r) =>
      r.direction === "entry" || r.direction === "exit" ? r.direction : null,
    getTime: (r) => r.event_time,
    sortByTime: false,
  });

  const personnel = match.list.map((p) => {
    const no = normalizeEmployeeNo(p.employee_no);
    const presence = presenceByEmployeeNo.get(no) || {
      isInside: false,
      lastEntryTime: null,
      lastExitTime: null,
    };
    return {
      id: p.id,
      unitId: p.person_group_id || 0,
      employeeId: no,
      name: p.full_name || p.employee_no || "",
      photoUrl: resolvePhotoUrl(p),
      ...personnelPresenceFields(presence, ISO_PERSONNEL_TIME_FORMAT),
    };
  });
  return { personnel, entryCount, exitCount };
}

module.exports = {
  getSiteData,
  getSiteLogs,
  getUnitPersonnel,
};
