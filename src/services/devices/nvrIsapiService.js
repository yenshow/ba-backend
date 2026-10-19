/**
 * NVR ISAPI：InputProxy 通道狀態、CMSearch 錄影、即時 RTSP URL 組裝
 */
const crypto = require("crypto");
const {
  createIsapiClient,
} = require("../accessControl/isapiClient");
const {
  pickTag,
  pickBlocks,
  formatIsapiLocalDateTime,
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
    const startTime = pickTag(block, "startTime");
    const endTime = pickTag(block, "endTime");
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
  const start = opts.start instanceof Date ? opts.start : new Date(opts.start);
  const end = opts.end instanceof Date ? opts.end : new Date(opts.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw createApiError(C.DEVICE_CONFIG_INVALID, "搜尋時間無效");
  }
  if (end.getTime() <= start.getTime()) {
    throw createApiError(C.DEVICE_CONFIG_INVALID, "結束時間須晚於開始時間");
  }
  const maxResults = Math.min(
    100,
    Math.max(1, Number(opts.maxResults) || 40),
  );
  const searchId = crypto.randomUUID();
  const startTime = formatIsapiLocalDateTime(start);
  const endTime = formatIsapiLocalDateTime(end);
  const xmlBody = buildCmSearchXml({
    searchId,
    trackId,
    startTime,
    endTime,
    maxResults,
  });

  try {
    const res = await client.request({
      method: "POST",
      path: "/ISAPI/ContentMgmt/search",
      data: xmlBody,
      headers: { "Content-Type": "application/xml" },
    });
    const body = responseBodyToString(res.data);
    const matches = parseSearchMatches(body);
    return {
      trackId,
      startTime,
      endTime,
      responseStatusStrg:
        pickTag(body, "responseStatusStrg") ||
        pickTag(body, "statusString") ||
        "",
      numOfMatches: pickTag(body, "numOfMatches"),
      totalMatches: pickTag(body, "totalMatches"),
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

module.exports = {
  buildLiveRtspUrl,
  injectRtspAuth,
  maskRtspUrl,
  resolveNvrConnection,
  listChannels,
  searchRecordings,
};
