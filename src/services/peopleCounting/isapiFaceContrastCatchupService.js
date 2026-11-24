/**
 * 人臉比對事件補齊：訂閱／heartbeat 後以協議時間窗短查 FCSearch；
 * 去重鍵＝device_id + deviceEventId（facePicID／snapFacePicID／UUID／snapPicURL path）。
 */
const logger = require("../../utils/logger").createLogger(
  "ISAPI FaceContrast Catchup",
);
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const {
  persistFaceContrastEvent,
  attachPictureToFaceContrastEvent,
  findExistingFaceEventByDeviceEventId,
} = require("./isapiFaceContrastPersistence");
const {
  createDebouncedScheduler,
  downloadIsapiPicture,
  formatIsapiLocalDateTime,
  pickTag,
  pickBlocks,
  toIsapiUrlPath,
  responseBodyToString,
  DEFAULT_DEBOUNCE_MS,
  PROTOCOL_LOOKBACK_SEC,
} = require("../isapi/isapiEventBackfillCommon");
const { escapeXml } = require("../isapi/isapiXmlUtils");

const FC_SEARCH_PATH = "/ISAPI/Intelligent/FDLib/FCSearch";
const PAGE_SIZE = 50;
const MAX_PAGES = 5;
const scheduler = createDebouncedScheduler(DEFAULT_DEBOUNCE_MS);

/** @type {Map<string, number>} key=location:device → lastCatchupAt ms */
const lastCatchupAt = new Map();

function firstOf(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function cacheKey(locationId, deviceId) {
  return `${Number(locationId)}:${Number(deviceId)}`;
}

function resolveProtocolTimeRange(eventTime) {
  const endMs = Date.now();
  const end = new Date(endMs);
  let startMs = endMs - PROTOCOL_LOOKBACK_SEC * 1000;
  if (eventTime != null) {
    const center = new Date(eventTime).getTime();
    if (Number.isFinite(center)) {
      startMs = Math.min(startMs, center - PROTOCOL_LOOKBACK_SEC * 1000);
    }
  }
  return { start: new Date(startMs), end };
}

/**
 * FCSearch MatchElement → 列；deviceEventId 優先 picID／UUID，否則 snapPicURL path
 */
function parseFcSearchResult(xml) {
  const text = String(xml || "");
  const elements = pickBlocks(text, "MatchElement");
  const out = [];
  for (const el of elements) {
    const snapTime = pickTag(el, "snapTime");
    if (!snapTime) continue;
    const matchInfo = pickBlocks(el, "FaceMatchInfo")[0] || "";
    const name = matchInfo ? pickTag(matchInfo, "name") : null;
    const similarityRaw = matchInfo ? pickTag(matchInfo, "similarity") : null;
    const similarity =
      similarityRaw != null && similarityRaw !== ""
        ? Number(similarityRaw)
        : null;
    const pid = matchInfo
      ? pickTag(matchInfo, "PID") || pickTag(matchInfo, "pid")
      : null;
    const faceLibName = matchInfo
      ? pickTag(matchInfo, "FDname") || pickTag(matchInfo, "FDLibName")
      : null;
    const customHumanID = matchInfo
      ? pickTag(matchInfo, "customHumanID") ||
        pickTag(matchInfo, "employeeNo") ||
        null
      : null;
    const snapPicURL =
      pickTag(el, "snapPicURL") ||
      pickTag(el, "facePicURL") ||
      (matchInfo ? pickTag(matchInfo, "picURL") : null);
    const deviceEventId = firstOf(
      pickTag(el, "facePicID"),
      pickTag(el, "facePicId"),
      pickTag(el, "snapFacePicID"),
      pickTag(el, "snapFacePicId"),
      pickTag(el, "UUID"),
      pickTag(el, "uuid"),
      matchInfo ? pickTag(matchInfo, "facePicID") : null,
      matchInfo ? pickTag(matchInfo, "UUID") : null,
      toIsapiUrlPath(snapPicURL),
    );
    const hasIdentity = Boolean(name || pid || customHumanID);
    if (matchInfo && !hasIdentity) continue;
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
      matched: hasIdentity,
      deviceEventId,
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
    const status = parsed.status;
    if (
      parsed.rows.length === 0 ||
      status === "OK" ||
      status === "NO MATCH" ||
      status === "NO MATCHES"
    ) {
      break;
    }
    position += parsed.rows.length;
  }
  return all;
}

/**
 * @param {{
 *   locationId: number,
 *   deviceId: number,
 *   channelId?: number,
 *   direction?: 'entry'|'exit'|null,
 *   eventTime?: string|Date|null,
 *   deviceIp?: string,
 * }} options
 */
async function runCatchup(options) {
  const locationId = Number(options?.locationId);
  const deviceId = Number(options?.deviceId);
  if (
    !Number.isFinite(locationId) ||
    locationId <= 0 ||
    !Number.isFinite(deviceId) ||
    deviceId <= 0
  ) {
    return { matched: 0, inserted: 0 };
  }

  const key = cacheKey(locationId, deviceId);
  const prevAt = lastCatchupAt.get(key);
  let { start, end } = resolveProtocolTimeRange(options?.eventTime);
  if (prevAt != null && Number.isFinite(prevAt)) {
    const floor = Math.max(start.getTime(), prevAt);
    if (floor < end.getTime()) start = new Date(floor);
  }

  const { device } = await deviceService.getDeviceById(deviceId);
  if (!device?.config?.host) {
    throw new Error("攝影機連線設定不完整");
  }
  const client = createIsapiClient(device.config, {
    typeCode: device.type_code,
  });
  const rows = await fetchFcSearchMatches(client, start, end);
  let inserted = 0;
  let skippedNoId = 0;

  for (const row of rows) {
    if (!row.deviceEventId) {
      skippedNoId += 1;
      continue;
    }
    const existing = await findExistingFaceEventByDeviceEventId(
      deviceId,
      row.deviceEventId,
    );
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
      deviceIp: options.deviceIp || device.config?.host || "",
      channelId: options.channelId ?? 1,
      eventTime: row.eventTime,
      eventType: "alarmResult",
      similarity: row.similarity,
      employeeNo: row.employeeNo,
      personName: row.personName,
      pid: row.pid,
      matched: row.matched,
      faceLibName: row.faceLibName,
      direction: options.direction || null,
      deviceEventId: row.deviceEventId,
      source: "catchup",
    });
    if (saved?.inserted && saved.id != null) {
      inserted += 1;
      if (row.picturePath) {
        const pic = await downloadIsapiPicture(client, row.picturePath);
        if (pic) await attachPictureToFaceContrastEvent(saved.id, pic);
      }
    }
  }

  lastCatchupAt.set(key, end.getTime());

  if (inserted > 0 || skippedNoId > 0) {
    logger.info("人臉事件 catch-up 完成", {
      locationId,
      deviceId,
      matched: rows.length,
      inserted,
      skippedNoId,
    });
  }
  if (skippedNoId > 0) {
    logger.warn("人臉 FCSearch 列缺少 deviceEventId，已略過", {
      locationId,
      deviceId,
      skippedNoId,
    });
  }
  return { matched: rows.length, inserted, skippedNoId };
}

/**
 * @param {{
 *   locationId: number,
 *   deviceId: number,
 *   channelId?: number,
 *   direction?: 'entry'|'exit'|null,
 *   eventTime?: string|Date|null,
 *   deviceIp?: string,
 * }} options
 */
function scheduleFaceContrastCatchup(options) {
  const locationId = Number(options?.locationId);
  const deviceId = Number(options?.deviceId);
  if (
    !Number.isFinite(locationId) ||
    locationId <= 0 ||
    !Number.isFinite(deviceId) ||
    deviceId <= 0
  ) {
    return;
  }
  const key = `face-catchup:${locationId}:${deviceId}`;
  scheduler.schedule(key, () =>
    runCatchup(options).catch((e) => {
      logger.warn("人臉事件補齊失敗", {
        locationId,
        deviceId,
        error: e?.message || String(e),
      });
    }),
  );
}

module.exports = {
  scheduleFaceContrastCatchup,
  parseFcSearchResult,
  runCatchup,
};
