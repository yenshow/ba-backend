/**
 * ISAPI 攝影機（isapi_camera）人流統計 Provider
 * 資料來源：isapi_people_counting_events
 *
 * 規格：
 * - 有分區資料時只使用 region 列；站點進／出／在場取「各區當日最新列」中 event_time 最後一筆者（典型單一 Area1 時與設備一致）
 * - 本版本不使用 global（region_id IS NULL），站點與單位皆以 region 列為準
 * - 在場 = enter − exit
 * - enter_delta／exit_delta 僅供 getSiteLogs 判斷進／離，不參與統計
 */
const db = require("../../../database/db");
const {
  computeCumulativeStats,
  sumCumulativeParts,
} = require("../../entryExit/stats");
const {
  ENTRY_EXIT_MAX_RECORDS,
  resolveStatsTimeRange,
} = require("../../entryExit/resolveTimeOptions");
const { resolvePeopleCountingStatsTimeRange, isStatsResetActive } = require("../peopleCountingConfig");
const C = require("../../../utils/apiErrorCodes");
const { throwApiError } = require("../../../utils/apiErrors");
const { ensureIntArray } = require("../../location/locationShared");

function ensureInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// 保留 ensureInt 供本檔其他運算使用（若未來需要）；整數陣列正規化由共用 ensureIntArray 統一處理

function stableUnitIdFromName(name) {
  const s = String(name || "").trim();
  if (!s) return 0;
  // djb2 hash (32-bit) → positive int
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0) % 2147483647;
}

async function getSiteConfigOrThrow(siteId, config) {
  const deviceIds = ensureIntArray(config.cameraDeviceIds);
  if (deviceIds.length === 0) {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "未設定攝影機設備（cameraDeviceIds）",
    );
  }
  const channelId = 1;
  return { deviceIds, channelId };
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

async function getSiteData(siteId, config) {
  const { deviceIds, channelId } = await getSiteConfigOrThrow(siteId, config);
  const today = resolvePeopleCountingStatsTimeRange({}, config.statsResetAt);
  // 站點統計：依「分區累計」彙總（不使用 global 列）
  let entryCount = 0;
  let exitCount = 0;
  let currentCount = 0;

  let units = [];
  if (isStatsResetActive(config.statsResetAt)) {
    const byRegion = await getStatsFromDeltasByRegion(
      siteId,
      deviceIds,
      channelId,
      today,
    );
    const sortedNames = [...byRegion.keys()].sort((a, b) =>
      a.localeCompare(b, "zh-Hant"),
    );
    units = sortedNames.map((name, idx) => {
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
  } else {
    const regionRows = await getLatestRegionTotalsByName(
      siteId,
      deviceIds,
      channelId,
      today,
    );

    if (regionRows.length > 0) {
      const sorted = [...regionRows].sort((a, b) =>
        String(a.region_name || "").localeCompare(
          String(b.region_name || ""),
          "zh-Hant",
        ),
      );

      units = sorted.map((r, idx) => {
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
  }

  const totals = sumCumulativeParts(units);
  entryCount = totals.entryCount;
  exitCount = totals.exitCount;
  currentCount = totals.currentCount;

  return { entryCount, exitCount, currentCount, units };
}

async function getSiteLogs(siteId, config, options = {}) {
  const { deviceIds, channelId } = await getSiteConfigOrThrow(siteId, config);
  const { start, end } = resolvePeopleCountingStatsTimeRange(
    options,
    config.statsResetAt,
  );
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), ENTRY_EXIT_MAX_RECORDS);
  const offset = Math.max(Number(options.offset) || 0, 0);

  const deviceNameById = new Map();
  try {
    const deviceRows = await db.query(
      `SELECT id, name FROM devices WHERE id = ANY(?::int[])`,
      [deviceIds],
    );
    for (const r of deviceRows || []) {
      if (r?.id != null) deviceNameById.set(Number(r.id), String(r.name || "").trim());
    }
  } catch {
    // ignore: fallback to IP
  }

  // 已移除 global 寫入：logs 固定以 region 列為準
  const regionFilterSql = "AND region_id IS NOT NULL";

  const toEvent = (row, eventType, unitName) => {
    const suffix = eventType === "entry" ? "in" : "out";
    const eventLabel = eventType === "entry" ? "進入" : "離開";
    const deviceName =
      deviceNameById.get(ensureInt(row.device_id)) || row.device_ip || "";
    return {
      id: `pc-cam-${row.id}-${suffix}`,
      personId: -1,
      personName: "—",
      unitId: null,
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
  const unitIdFilter = ensureInt(options.unitId);

  // 為了湊滿「事件數」，每次多抓一些 row（因為 row 可能展開成 0～2 個事件）
  const batchSize = Math.min(Math.max(limit * 10, 50), 1000);
  let rowOffset = offset;

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

      if (unitIdFilter && stableUnitIdFromName(unitName) !== unitIdFilter) {
        continue;
      }

      if (enterDelta > 0) events.push(toEvent(r, "entry", unitName));
      if (events.length >= limit) break;
      if (exitDelta > 0) events.push(toEvent(r, "exit", unitName));
    }

    if (rows.length < batchSize) break;
    rowOffset += rows.length;
  }

  return { logs: events.slice(0, limit) };
}

async function getUnitPersonnel(_unitId, _siteId, _config) {
  return { personnel: [], entryCount: 0, exitCount: 0 };
}

module.exports = {
  getSiteData,
  getSiteLogs,
  getUnitPersonnel,
};
