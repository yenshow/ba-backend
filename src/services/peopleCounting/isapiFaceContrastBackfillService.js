/**
 * 人臉比對事件補齊：訂閱 alarmResult 後，以攝影機 FCSearch（Intelligent）短查近 N 秒
 * 注意：門禁機請走 AcsEvent，勿對 access_control 呼叫本服務。
 */
const logger = require("../../utils/logger").createLogger(
  "ISAPI FaceContrast Backfill",
);
const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const {
  persistFaceContrastEvent,
  attachPictureToFaceContrastEvent,
} = require("./isapiFaceContrastPersistence");
const {
  resolveBackfillTimeRange,
  formatIsapiLocalDateTime,
  createDebouncedScheduler,
  normalizeEventBackfillWindowSec,
  pickTag,
  pickBlocks,
  toIsapiUrlPath,
  responseBodyToString,
  isSearchCompleteStatus,
  downloadIsapiPicture,
} = require("../isapi/isapiEventBackfillCommon");
const { escapeXml } = require("../isapi/isapiXmlUtils");

const FC_SEARCH_PATH = "/ISAPI/Intelligent/FDLib/FCSearch";
const PAGE_SIZE = 50;
const MAX_PAGES = 5;
const scheduler = createDebouncedScheduler();

function parseFcSearchResult(xml) {
  const text = String(xml || "");
  const elements = pickBlocks(text, "MatchElement");
  const out = [];
  for (const el of elements) {
    const snapTime = pickTag(el, "snapTime");
    const matchInfo = pickBlocks(el, "FaceMatchInfo")[0] || "";
    if (!matchInfo) continue;
    const name = pickTag(matchInfo, "name");
    const similarityRaw = pickTag(matchInfo, "similarity");
    const similarity =
      similarityRaw != null && similarityRaw !== ""
        ? Number(similarityRaw)
        : null;
    const pid = pickTag(matchInfo, "PID") || pickTag(matchInfo, "pid");
    const faceLibName =
      pickTag(matchInfo, "FDname") || pickTag(matchInfo, "FDLibName");
    const customHumanID =
      pickTag(matchInfo, "customHumanID") ||
      pickTag(matchInfo, "employeeNo") ||
      null;
    const snapPicURL =
      pickTag(el, "snapPicURL") ||
      pickTag(el, "facePicURL") ||
      pickTag(matchInfo, "picURL");
    if (!snapTime || (!name && !pid && !customHumanID)) continue;
    out.push({
      eventTime:
        snapTime.includes("+") || snapTime.endsWith("Z")
          ? snapTime
          : `${snapTime}+08:00`,
      personName: name || null,
      employeeNo: customHumanID || null,
      pid: pid || null,
      similarity: Number.isFinite(similarity) ? similarity : null,
      faceLibName: faceLibName || null,
      picturePath: toIsapiUrlPath(snapPicURL),
    });
  }
  return {
    rows: out,
    status: String(pickTag(text, "responseStatusStrg") || "").toUpperCase(),
  };
}

function buildFcSearchXml({ searchId, position, start, end }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<FCSearchDescription version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <searchID>${escapeXml(searchId)}</searchID>
  <searchResultPosition>${Math.max(1, position)}</searchResultPosition>
  <maxResults>${PAGE_SIZE}</maxResults>
  <snapStartTime>${escapeXml(formatIsapiLocalDateTime(start))}</snapStartTime>
  <snapEndTime>${escapeXml(formatIsapiLocalDateTime(end))}</snapEndTime>
  <eventType>faceContrast</eventType>
</FCSearchDescription>`;
}

async function fetchFcSearchMatches(client, start, end) {
  const searchId = `ba-fc-${Date.now()}`;
  const all = [];
  let position = 1;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await client.request({
      method: "POST",
      path: FC_SEARCH_PATH,
      data: buildFcSearchXml({ searchId, position, start, end }),
      headers: { "Content-Type": "application/xml" },
    });
    const parsed = parseFcSearchResult(responseBodyToString(res.data));
    all.push(...parsed.rows);
    if (parsed.rows.length === 0 || isSearchCompleteStatus(parsed.status)) {
      break;
    }
    position += parsed.rows.length > 0 ? parsed.rows.length : PAGE_SIZE;
  }
  return all;
}

async function findExistingFaceEvent(deviceId, eventTime, row) {
  const who = String(row.employeeNo || row.personName || "").trim();
  const pid = row.pid != null ? String(row.pid).trim() : "";
  const rows = await db.query(
    `SELECT id, picture_path
     FROM isapi_face_contrast_events
     WHERE device_id = ?
       AND date_trunc('second', event_time) = date_trunc('second', ?::timestamptz)
       AND (
         (? <> '' AND COALESCE(pid, '') = ?)
         OR (
           ? <> ''
           AND (
             COALESCE(NULLIF(employee_no, ''), '') = ?
             OR COALESCE(NULLIF(person_name, ''), '') = ?
           )
         )
       )
     ORDER BY id ASC
     LIMIT 1`,
    [deviceId, eventTime, pid, pid, who, who, who],
  );
  const r = rows?.[0];
  if (!r) return { id: null, hasPicture: false };
  return {
    id: Number(r.id),
    hasPicture: Boolean(String(r.picture_path || "").trim()),
  };
}

async function runBackfill(job) {
  const {
    locationId,
    deviceId,
    channelId,
    direction,
    eventTime,
    windowSec,
    deviceIp,
  } = job;
  const { start, end } = resolveBackfillTimeRange(eventTime, windowSec);
  const { device } = await deviceService.getDeviceById(deviceId);
  if (!device?.config?.host) {
    throw new Error("攝影機連線設定不完整");
  }
  const client = createIsapiClient(device.config, {
    typeCode: device.type_code || "camera",
  });
  const matches = await fetchFcSearchMatches(client, start, end);
  let inserted = 0;
  for (const row of matches) {
    const existing = await findExistingFaceEvent(deviceId, row.eventTime, row);
    if (existing.id != null) {
      if (!existing.hasPicture && row.picturePath) {
        const pic = await downloadIsapiPicture(client, row.picturePath);
        if (pic) await attachPictureToFaceContrastEvent(existing.id, pic);
      }
      continue;
    }
    const saved = await persistFaceContrastEvent({
      locationId,
      deviceId,
      deviceIp: deviceIp || device.config?.host || "",
      channelId: channelId || 1,
      eventTime: row.eventTime,
      eventType: "alarmResult",
      similarity: row.similarity,
      employeeNo: row.employeeNo,
      personName: row.personName,
      pid: row.pid,
      matched: true,
      faceLibName: row.faceLibName,
      direction: direction || null,
      source: "backfill",
    });
    if (saved?.id != null) {
      inserted += 1;
      if (row.picturePath) {
        const pic = await downloadIsapiPicture(client, row.picturePath);
        if (pic) await attachPictureToFaceContrastEvent(saved.id, pic);
      }
    }
  }
  logger.info("人臉事件補齊完成", {
    deviceId,
    locationId,
    windowSec: normalizeEventBackfillWindowSec(windowSec),
    matched: matches.length,
    inserted,
  });
  return { matched: matches.length, inserted };
}

function scheduleFaceContrastBackfill(options) {
  const enabled = Boolean(options?.enabled);
  if (!enabled) return;
  const deviceId = Number(options.deviceId);
  const locationId = Number(options.locationId);
  if (!Number.isFinite(deviceId) || !Number.isFinite(locationId)) return;
  const windowSec = normalizeEventBackfillWindowSec(options.windowSec);
  scheduler.schedule(`face:${locationId}:${deviceId}`, () =>
    runBackfill({
      locationId,
      deviceId,
      channelId: options.channelId,
      direction: options.direction,
      eventTime: options.eventTime,
      windowSec,
      deviceIp: options.deviceIp,
    }).catch((e) => {
      logger.warn("人臉事件補齊失敗", {
        deviceId,
        locationId,
        error: e?.message || String(e),
      });
    }),
  );
}

module.exports = {
  scheduleFaceContrastBackfill,
  parseFcSearchResult,
};
