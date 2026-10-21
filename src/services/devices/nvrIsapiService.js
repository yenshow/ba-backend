/**
 * NVR ISAPI：InputProxy 通道狀態、CMSearch／月曆、ContentMgmt/download、即時 RTSP URL 組裝
 */
const crypto = require("crypto");
const {
  createIsapiClient,
} = require("../accessControl/isapiClient");
const {
  pickTag,
  pickBlocks,
  formatIsapiLocalDateTime,
  normalizeNvrWallClockDateTime,
  decodeXmlEntities,
  responseBodyToString,
} = require("../isapi/isapiEventBackfillCommon");
const C = require("../../utils/apiErrorCodes");
const { createApiError, throwApiError } = require("../../utils/apiErrors");

const encodeRtspUserInfo = (user, pass) => {
  const u = encodeURIComponent(String(user || ""));
  const p = encodeURIComponent(String(pass || ""));
  return `${u}:${p}`;
};

const maskRtspUrl = (url) =>
  String(url || "").replace(/^(rtsp:\/\/[^:/@]+):([^@]+)@/i, "$1:***@");

const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_MATCHES = 2000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const escapeXml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Hikvision RTSP 區間：YYYYMMDDTHHMMSSZ。
 * 設備把 Z 當台北牆鐘而非真正 UTC；與 CMSearch 一樣用 Asia/Taipei。
 */
function formatHikvisionTaipeiCompact(date) {
  const local = formatIsapiLocalDateTime(date);
  if (!local) return "";
  return local.replace(/[-:]/g, "").replace("+0800", "Z");
}

function toDate(value) {
  if (value instanceof Date) return value;
  return new Date(value);
}

function stripRtspAuth(uri) {
  const raw = String(uri || "").trim();
  if (!raw.toLowerCase().startsWith("rtsp://")) return raw;
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return raw.replace(/^(rtsp:\/\/)[^@]+@/i, "$1");
  }
}

/**
 * 回放 RTSP（不含帳密；之後 injectRtspAuth）
 * rtsp://host[:port]/ISAPI/Streaming/tracks/{trackId}?starttime=&endtime=
 */
function buildPlaybackRtspUrl({ host, rtspPort, trackId, start, end }) {
  const id = Number(trackId);
  const startAt = formatHikvisionTaipeiCompact(start);
  const endAt = formatHikvisionTaipeiCompact(end);
  if (!host || !Number.isFinite(id) || id <= 0 || !startAt || !endAt) {
    return null;
  }
  const port = Number(rtspPort) || 554;
  const portPart = port === 554 ? "" : `:${port}`;
  return `rtsp://${host}${portPart}/ISAPI/Streaming/tracks/${id}?starttime=${startAt}&endtime=${endAt}`;
}

/** 即時 RTSP：rtsp://user:pass@host[:port]/Streaming/Channels/{proxyChannelId} */
function buildLiveRtspUrl({ host, rtspPort, username, password, channelId }) {
  const id = Number(channelId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const auth = encodeRtspUserInfo(username, password);
  const port = Number(rtspPort) || 554;
  const portPart = port === 554 ? "" : `:${port}`;
  return `rtsp://${auth}@${host}${portPart}/Streaming/Channels/${id}`;
}

/**
 * playbackURI 無帳密時注入；已有 userinfo 則覆寫為 NVR 帳密
 */
function injectRtspAuth(uri, username, password) {
  const raw = String(uri || "").trim();
  if (!raw.toLowerCase().startsWith("rtsp://")) return raw;
  try {
    const u = new URL(raw);
    u.username = String(username || "");
    u.password = String(password || "");
    return u.toString();
  } catch {
    // URL 對部分 rtsp 可能失敗；改字串注入
    const withoutScheme = raw.replace(/^rtsp:\/\//i, "");
    const afterAt = withoutScheme.includes("@")
      ? withoutScheme.split("@").slice(1).join("@")
      : withoutScheme;
    return `rtsp://${encodeRtspUserInfo(username, password)}@${afterAt}`;
  }
}

function parseProxyChannelIds(listXml) {
  if (!listXml) return [];
  const ids = [];
  const re =
    /<(?:streamingProxyChannelId|id)(?:\s[^>]*)?>([\s\S]*?)<\/(?:streamingProxyChannelId|id)>/gi;
  let m;
  while ((m = re.exec(listXml)) !== null) {
    const n = Number(String(m[1]).trim());
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  if (ids.length === 0) {
    const plain = String(listXml)
      .replace(/<[^>]+>/g, " ")
      .split(/[\s,;]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    ids.push(...plain);
  }
  return [...new Set(ids)];
}

function parseChannelStatuses(xml) {
  const blocks = [
    ...pickBlocks(xml, "InputProxyChannelStatus"),
    ...pickBlocks(xml, "InputProxyChannel"),
  ];
  return blocks.map((block) => {
    const id = Number(pickTag(block, "id"));
    const ipAddress = pickTag(block, "ipAddress") || "";
    const onlineRaw = (pickTag(block, "online") || "").toLowerCase();
    const online =
      onlineRaw === "true" || onlineRaw === "1" || onlineRaw === "yes";
    const chanDetectResult = pickTag(block, "chanDetectResult") || "";
    const proxyListXml =
      pickTag(block, "streamingProxyChannelIdList") ||
      pickTag(block, "StreamingProxyChannelIdList") ||
      "";
    const streamingProxyChannelIds = parseProxyChannelIds(proxyListXml);
    const singleProxy = Number(
      pickTag(block, "streamingProxyChannelId") ||
        pickTag(block, "StreamingProxyChannelId") ||
        "",
    );
    if (Number.isFinite(singleProxy) && singleProxy > 0) {
      if (!streamingProxyChannelIds.includes(singleProxy)) {
        streamingProxyChannelIds.push(singleProxy);
      }
    }
    const srcName =
      pickTag(block, "name") ||
      pickTag(block, "srcName") ||
      pickTag(block, "channelName") ||
      "";
    /** 主碼流：優先 x01（海康慣例） */
    const liveTrackId =
      streamingProxyChannelIds.find((n) => n % 100 === 1) ??
      streamingProxyChannelIds[0] ??
      null;
    return {
      id: Number.isFinite(id) ? id : null,
      name: srcName,
      ipAddress,
      online,
      chanDetectResult,
      streamingProxyChannelIds,
      liveTrackId,
    };
  });
}

function buildCmSearchXml({
  searchId,
  trackId,
  startTime,
  endTime,
  maxResults,
  searchResultPosition = 0,
}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <searchID>${searchId}</searchID>
  <trackList>
    <trackID>${trackId}</trackID>
  </trackList>
  <timeSpanList>
    <timeSpan>
      <startTime>${startTime}</startTime>
      <endTime>${endTime}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>${maxResults}</maxResults>
  <searchResultPostion>${searchResultPosition}</searchResultPostion>
  <metadataList>
    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
  </metadataList>
</CMSearchDescription>`;
}

function parseSearchMatches(xml) {
  const blocks = pickBlocks(xml, "searchMatchItem");
  return blocks.map((block, index) => {
    const trackId = pickTag(block, "trackID") || pickTag(block, "trackId");
    const startTime = normalizeNvrWallClockDateTime(pickTag(block, "startTime"));
    const endTime = normalizeNvrWallClockDateTime(pickTag(block, "endTime"));
    const playbackURI = decodeXmlEntities(
      pickTag(block, "playbackURI") || pickTag(block, "PlaybackURI") || "",
    );
    const mediaSegmentDescriptor =
      pickTag(block, "mediaSegmentDescriptor") || "";
    const contentType =
      pickTag(mediaSegmentDescriptor, "contentType") ||
      pickTag(block, "contentType") ||
      "";
    const codecType =
      pickTag(mediaSegmentDescriptor, "codecType") ||
      pickTag(block, "codecType") ||
      "";
    return {
      index: index + 1,
      trackId,
      startTime,
      endTime,
      contentType,
      codecType,
      playbackURI,
    };
  });
}

function resolveNvrConnection(config) {
  const cfg = config && typeof config === "object" ? config : {};
  if (cfg.is_nvr !== true) {
    throw createApiError(C.DEVICE_NOT_NVR, "此設備不是 NVR 分類攝影機");
  }
  const host = String(cfg.host || "").trim();
  const username = String(cfg.username || "").trim();
  const password = cfg.password != null ? String(cfg.password) : "";
  if (!host || !username || !password) {
    throw createApiError(
      C.DEVICE_NVR_CREDENTIALS_MISSING,
      "NVR 需設定 host、username、password",
    );
  }
  const port = Number(cfg.port) || 80;
  const rtspPort = Number(cfg.rtsp_port) || 554;
  return { host, port, username, password, rtspPort };
}

function createNvrClient(config) {
  const conn = resolveNvrConnection(config);
  const client = createIsapiClient(
    {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      password: conn.password,
    },
    { typeCode: "camera" },
  );
  return { client, conn };
}

async function listChannels(config) {
  const { client, conn } = createNvrClient(config);
  try {
    const res = await client.request({
      method: "GET",
      path: "/ISAPI/ContentMgmt/InputProxy/channels/status",
    });
    const xml = responseBodyToString(res.data);
    const channels = parseChannelStatuses(xml);
    return {
      host: conn.host,
      rtspPort: conn.rtspPort,
      channels,
    };
  } catch (err) {
    if (err?.code) throw err;
    throwApiError(
      C.DEVICE_NVR_ISAPI_FAILED,
      `NVR 通道狀態查詢失敗: ${err?.message || err}`,
    );
  }
}

/**
 * @param {object} config
 * @param {{ trackId: number, start: Date|string, end: Date|string, maxResults?: number }} opts
 */
async function searchRecordings(config, opts) {
  const { client } = createNvrClient(config);
  const trackId = Number(opts?.trackId);
  if (!Number.isFinite(trackId) || trackId <= 0) {
    throw createApiError(C.DEVICE_NVR_CHANNEL_INVALID, "trackId 無效");
  }
  const start = toDate(opts.start);
  const end = toDate(opts.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw createApiError(C.DEVICE_CONFIG_INVALID, "搜尋時間無效");
  }
  if (end.getTime() <= start.getTime()) {
    throw createApiError(C.DEVICE_CONFIG_INVALID, "結束時間須晚於開始時間");
  }
  const limit = Math.min(
    SEARCH_MAX_MATCHES,
    Math.max(1, Number(opts.maxResults) || SEARCH_MAX_MATCHES),
  );
  const pageSize = Math.min(SEARCH_PAGE_SIZE, limit);
  const searchId = crypto.randomUUID();
  const startTime = formatIsapiLocalDateTime(start);
  const endTime = formatIsapiLocalDateTime(end);

  try {
    const matches = [];
    let responseStatusStrg = "";
    let totalMatches = "";
    let position = 0;
    let page = 0;

    while (matches.length < limit && page < 20) {
      page += 1;
      const remaining = limit - matches.length;
      const xmlBody = buildCmSearchXml({
        searchId,
        trackId,
        startTime,
        endTime,
        maxResults: Math.min(pageSize, remaining),
        searchResultPosition: position,
      });
      const res = await client.request({
        method: "POST",
        path: "/ISAPI/ContentMgmt/search",
        data: xmlBody,
        headers: { "Content-Type": "application/xml" },
      });
      const body = responseBodyToString(res.data);
      const pageMatches = parseSearchMatches(body);
      responseStatusStrg =
        pickTag(body, "responseStatusStrg") ||
        pickTag(body, "statusString") ||
        responseStatusStrg;
      totalMatches = pickTag(body, "totalMatches") || totalMatches;
      if (pageMatches.length === 0) break;
      matches.push(...pageMatches);
      position += pageMatches.length;
      const total = Number(totalMatches);
      if (Number.isFinite(total) && total > 0 && matches.length >= total) break;
      if (String(responseStatusStrg).toUpperCase() !== "MORE") break;
    }

    matches.forEach((item, index) => {
      item.index = index + 1;
    });

    return {
      trackId,
      startTime,
      endTime,
      responseStatusStrg,
      numOfMatches: String(matches.length),
      totalMatches: totalMatches || String(matches.length),
      matches,
    };
  } catch (err) {
    if (err?.code) throw err;
    throwApiError(
      C.DEVICE_NVR_ISAPI_FAILED,
      `NVR 錄影搜尋失敗: ${err?.message || err}`,
    );
  }
}

function resolvePlaybackUri(conn, body) {
  const fromUri = String(body?.playbackURI || body?.playback_uri || "").trim();
  if (fromUri.toLowerCase().startsWith("rtsp://")) return fromUri;
  const trackId = body?.trackId ?? body?.track_id;
  const start = body?.startTime ?? body?.start_time ?? body?.start;
  const end = body?.endTime ?? body?.end_time ?? body?.end;
  const built = buildPlaybackRtspUrl({
    host: conn.host,
    rtspPort: conn.rtspPort,
    trackId,
    start,
    end,
  });
  return built || "";
}

async function downloadRecording(config, body) {
  const { client, conn } = createNvrClient(config);
  const playbackURI = resolvePlaybackUri(conn, body);
  if (!playbackURI.toLowerCase().startsWith("rtsp://")) {
    throw createApiError(
      C.DEVICE_NVR_PLAYBACK_URI_MISSING,
      "缺少有效的 playbackURI 或 trackId／時間區間",
    );
  }
  const xmlUri = stripRtspAuth(playbackURI);
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<downloadRequest version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <playbackURI>${escapeXml(xmlUri)}</playbackURI>
</downloadRequest>`;

  try {
    const res = await client.request({
      method: "POST",
      path: "/ISAPI/ContentMgmt/download",
      data: xmlBody,
      headers: { "Content-Type": "application/xml" },
      responseType: "stream",
      timeout: DOWNLOAD_TIMEOUT_MS,
    });
    return {
      stream: res.data,
      contentType: res.headers?.["content-type"] || "video/mp4",
      contentLength: res.headers?.["content-length"] || "",
    };
  } catch (err) {
    if (err?.code) throw err;
    throwApiError(
      C.DEVICE_NVR_ISAPI_FAILED,
      `NVR 錄影下載失敗: ${err?.message || err}`,
    );
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseTrackIdList(raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  const ids = [];
  for (const item of values) {
    if (item == null || item === "") continue;
    String(item)
      .split(/[,\s]+/)
      .forEach((part) => {
        const n = Number(part);
        if (Number.isFinite(n) && n > 0) ids.push(n);
      });
  }
  return [...new Set(ids)];
}

function taipeiMonthRange(year, month) {
  const start = new Date(`${year}-${pad2(month)}-01T00:00:00+08:00`);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = new Date(
    new Date(`${nextYear}-${pad2(nextMonth)}-01T00:00:00+08:00`).getTime() - 1,
  );
  return { start, end };
}

function isRecordedDayFlag(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  return raw !== "false" && raw !== "0" && raw !== "no" && raw !== "none";
}

function parseDailyDistributionDays(xml, year, month) {
  const days = new Set();
  const blocks = pickBlocks(xml, "day");
  for (const block of blocks) {
    const dayNum = Number(
      pickTag(block, "id") ||
        pickTag(block, "dayOfMonth") ||
        pickTag(block, "dayOfTheMonth") ||
        "",
    );
    if (!Number.isFinite(dayNum) || dayNum < 1 || dayNum > 31) continue;
    const recordRaw =
      pickTag(block, "record") ||
      pickTag(block, "recordType") ||
      pickTag(block, "hasRecord") ||
      "";
    if (recordRaw && !isRecordedDayFlag(recordRaw)) continue;
    days.add(`${year}-${pad2(month)}-${pad2(dayNum)}`);
  }
  return [...days].sort();
}

function daysFromSearchMatches(matches) {
  const days = new Set();
  for (const match of matches || []) {
    const start = normalizeNvrWallClockDateTime(match.startTime);
    const ymd = String(start || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) days.add(ymd);
  }
  return [...days].sort();
}

async function listTrackCalendarDays(config, { year, month, trackId }) {
  const { client } = createNvrClient(config);
  try {
    const res = await client.request({
      method: "GET",
      path: `/ISAPI/ContentMgmt/record/tracks/${trackId}/dailyDistribution?year=${year}&month=${month}`,
    });
    const xml = responseBodyToString(res.data);
    if (/dailyDistribution|dayList|trackDailyDistribution/i.test(xml)) {
      return parseDailyDistributionDays(xml, year, month);
    }
  } catch {
    // 設備不支援 dailyDistribution 時改走當月 CMSearch
  }
  const { start, end } = taipeiMonthRange(year, month);
  const result = await searchRecordings(config, { trackId, start, end });
  return daysFromSearchMatches(result?.matches);
}

/**
 * @param {object} config
 * @param {{ year: number, month: number, trackIds: number[] }} opts
 */
async function listCalendarDays(config, opts) {
  const year = Number(opts?.year);
  const month = Number(opts?.month);
  if (!Number.isFinite(year) || year < 1970 || year > 2100) {
    throw createApiError(C.DEVICE_CONFIG_INVALID, "年份無效");
  }
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    throw createApiError(C.DEVICE_CONFIG_INVALID, "月份無效");
  }
  const trackIds = parseTrackIdList(opts?.trackIds);
  if (trackIds.length === 0) {
    throw createApiError(C.DEVICE_NVR_CHANNEL_INVALID, "trackId 無效");
  }
  const days = new Set();
  for (const trackId of trackIds) {
    const part = await listTrackCalendarDays(config, { year, month, trackId });
    part.forEach((ymd) => days.add(ymd));
  }
  return {
    year,
    month,
    trackIds,
    days: [...days].sort(),
  };
}

module.exports = {
  buildLiveRtspUrl,
  injectRtspAuth,
  maskRtspUrl,
  resolveNvrConnection,
  resolvePlaybackUri,
  listChannels,
  searchRecordings,
  listCalendarDays,
  downloadRecording,
  formatHikvisionTaipeiCompact,
};
