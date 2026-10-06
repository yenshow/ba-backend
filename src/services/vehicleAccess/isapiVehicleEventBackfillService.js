/**
 * 車牌 ANPR 事件補齊：訂閱寫入後短查攝影機 Traffic vehicleDetect 歷史
 * 注意：與門禁 AcsEvent、人臉 FCSearch 為不同設備 API；設備離線／不支援時僅 warn。
 */
const logger = require("../../utils/logger").createLogger(
  "ISAPI Vehicle Backfill",
);
const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const { parseAnprEventXml } = require("./isapiVehicleXmlParser");
const { persistAnprEvent } = require("./isapiVehiclePersistence");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const {
  resolveBackfillTimeRange,
  formatIsapiLocalDateTime,
  createDebouncedScheduler,
  normalizeEventBackfillWindowSec,
  pickTag,
  pickBlocks,
  responseBodyToString,
  isSearchCompleteStatus,
  mergeEventBackfillPrefs,
} = require("../isapi/isapiEventBackfillCommon");
const { escapeXml } = require("../isapi/isapiXmlUtils");

const PAGE_SIZE = 30;
const MAX_PAGES = 5;
const SEARCH_PATHS = (channelId) => [
  `/ISAPI/Traffic/channels/${channelId}/vehicleDetectResult/search`,
  `/ISAPI/Traffic/channels/${channelId}/vehicleDetect/search`,
];
const scheduler = createDebouncedScheduler();

function parseVehicleSearchXml(xml) {
  const text = String(xml || "");
  const blocks = [
    ...pickBlocks(text, "MatchElement"),
    ...pickBlocks(text, "VehicleDetectResult"),
    ...pickBlocks(text, "ITCResult"),
  ];
  const out = [];
  for (const block of blocks) {
    const plate =
      pickTag(block, "licensePlate") ||
      pickTag(block, "LicensePlate") ||
      pickTag(block, "plateNo");
    const dateTime =
      pickTag(block, "dateTime") ||
      pickTag(block, "absoluteTime") ||
      pickTag(block, "time");
    const listType =
      pickTag(block, "listType") ||
      pickTag(block, "vehicleType") ||
      pickTag(block, "plateType");
    if (!plate || !dateTime) continue;
    out.push({
      licensePlate: plate,
      dateTime:
        dateTime.includes("+") || /Z$/i.test(dateTime)
          ? dateTime
          : `${dateTime}+08:00`,
      listType: listType || null,
      eventType: "ANPR",
    });
  }
  return out;
}

function buildSearchXml({ searchId, position, start, end }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <searchID>${escapeXml(searchId)}</searchID>
  <searchResultPosition>${Math.max(0, position)}</searchResultPosition>
  <maxResults>${PAGE_SIZE}</maxResults>
  <timeSpanList>
    <timeSpan>
      <startTime>${escapeXml(formatIsapiLocalDateTime(start))}</startTime>
      <endTime>${escapeXml(formatIsapiLocalDateTime(end))}</endTime>
    </timeSpan>
  </timeSpanList>
</CMSearchDescription>`;
}

async function trySearch(client, channelId, start, end) {
  const searchId = `ba-anpr-${Date.now()}`;
  let lastErr = null;
  for (const path of SEARCH_PATHS(channelId)) {
    try {
      const all = [];
      let position = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const res = await client.request({
          method: "POST",
          path,
          data: buildSearchXml({ searchId, position, start, end }),
          headers: { "Content-Type": "application/xml" },
        });
        const body = responseBodyToString(res.data);
        const rows = parseVehicleSearchXml(body);
        if (rows.length === 0 && /ANPR/i.test(body)) {
          const parsed = parseAnprEventXml(body);
          if (parsed?.licensePlate && parsed?.dateTime) rows.push(parsed);
        }
        all.push(...rows);
        const status = pickTag(body, "responseStatusStrg");
        if (rows.length === 0 || isSearchCompleteStatus(status)) break;
        position += rows.length > 0 ? rows.length : PAGE_SIZE;
      }
      return all;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

async function findExistingVehicleLog(deviceId, locationId, dateTime, plate) {
  const p = normalizePlate(plate);
  const rows = await db.query(
    `SELECT id
     FROM vehicle_passageway_logs
     WHERE device_id = ?
       AND location_id = ?
       AND date_trunc('second', trigger_time) = date_trunc('second', ?::timestamptz)
       AND UPPER(REPLACE(COALESCE(license_plate, ''), ' ', '')) = ?
     ORDER BY id ASC
     LIMIT 1`,
    [deviceId, locationId, dateTime, p],
  );
  return rows?.[0]?.id != null ? Number(rows[0].id) : null;
}

function resolveVehicleBackfillFromTargets(locationTargets) {
  return mergeEventBackfillPrefs(locationTargets || []);
}

async function runBackfill({ deviceId, eventTime, windowSec, locationTargets }) {
  const { start, end } = resolveBackfillTimeRange(eventTime, windowSec);
  const { device } = await deviceService.getDeviceById(deviceId);
  if (!device?.config?.host) throw new Error("攝影機連線設定不完整");
  const client = createIsapiClient(device.config, {
    typeCode: device.type_code || "camera",
  });
  const matches = await trySearch(client, 1, start, end);
  let inserted = 0;
  for (const row of matches) {
    const parsed = {
      dateTime: row.dateTime,
      eventType: row.eventType || "ANPR",
      licensePlate: row.licensePlate,
      listType: row.listType,
    };
    /** persistAnprEvent 無去重，必須先過濾已存在的地點，避免重複插入 */
    const targetsNeedingInsert = [];
    for (const target of locationTargets || []) {
      const existingId = await findExistingVehicleLog(
        deviceId,
        target.locationId,
        parsed.dateTime,
        parsed.licensePlate,
      );
      if (existingId == null) targetsNeedingInsert.push(target);
    }
    if (targetsNeedingInsert.length === 0) continue;
    const result = await persistAnprEvent({
      parsed,
      deviceId,
      locationTargets: targetsNeedingInsert,
    });
    if (result?.inserted) inserted += result.ids?.length || 0;
  }
  logger.info("車牌事件補齊完成", {
    deviceId,
    windowSec: normalizeEventBackfillWindowSec(windowSec),
    matched: matches.length,
    inserted,
  });
  return { matched: matches.length, inserted };
}

function scheduleVehicleEventBackfill(options) {
  const deviceId = Number(options?.deviceId);
  if (!Number.isFinite(deviceId) || deviceId <= 0) return;
  const locationTargets = options.locationTargets || [];
  const cfg = resolveVehicleBackfillFromTargets(locationTargets);
  if (!cfg.enabled) return;

  scheduler.schedule(`vehicle:${deviceId}`, () =>
    runBackfill({
      deviceId,
      eventTime: options.eventTime,
      windowSec: cfg.windowSec,
      locationTargets,
    }).catch((e) => {
      logger.warn("車牌事件補齊失敗", {
        deviceId,
        error: e?.message || String(e),
      });
    }),
  );
}

module.exports = {
  scheduleVehicleEventBackfill,
  resolveVehicleBackfillFromTargets,
  parseVehicleSearchXml,
  runBackfill,
};
