/**
 * NVR 虛擬通道串流／回放（MediaMTX path，不寫入 mediamtx.generated.yml）
 */
const crypto = require("crypto");
const deviceService = require("./deviceService");
const mediaMTXService = require("../communication/mediaMTXService");
const nvrIsapiService = require("./nvrIsapiService");
const logger = require("../../utils/logger").createLogger("NVR Stream");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");

const PLAYBACK_TTL_MS = 30 * 60 * 1000;
/** @type {Map<string, { pathName: string, nvrId: number, expiresAt: number, timer: NodeJS.Timeout }>} */
const playbackSessions = new Map();
const liveStartInFlight = new Map();

function pathNameLive(nvrId, proxyChannelId) {
  return `nvr-${nvrId}-ch-${proxyChannelId}`;
}

function pathNamePlayback(nvrId, sessionId) {
  return `nvr-${nvrId}-pb-${sessionId}`;
}

async function getNvrDevice(nvrId) {
  const { device } = await deviceService.getDeviceById(nvrId);
  const typeCode = String(device.type_code || "").toLowerCase();
  if (typeCode !== "camera") {
    throw createApiError(C.DEVICE_NOT_CAMERA, "此設備並非攝影機類型");
  }
  if (device.config?.is_nvr !== true) {
    throw createApiError(C.DEVICE_NOT_NVR, "此設備不是 NVR 分類攝影機");
  }
  return device;
}

async function listChannels(nvrId) {
  const device = await getNvrDevice(nvrId);
  const result = await nvrIsapiService.listChannels(device.config);
  return {
    nvrId,
    nvrName: device.name,
    host: result.host,
    rtspPort: result.rtspPort,
    channels: result.channels,
  };
}

async function startChannelStream(nvrId, proxyChannelId) {
  const proxyId = Number(proxyChannelId);
  if (!Number.isFinite(proxyId) || proxyId <= 0) {
    throw createApiError(C.DEVICE_NVR_CHANNEL_INVALID, "proxyChannelId 無效");
  }
  const key = `${nvrId}:${proxyId}`;
  if (liveStartInFlight.has(key)) {
    return await liveStartInFlight.get(key);
  }

  const task = (async () => {
    const device = await getNvrDevice(nvrId);
    const conn = nvrIsapiService.resolveNvrConnection(device.config);
    const rtspUrl = nvrIsapiService.buildLiveRtspUrl({
      host: conn.host,
      rtspPort: conn.rtspPort,
      username: conn.username,
      password: conn.password,
      channelId: proxyId,
    });
    if (!rtspUrl) {
      throw createApiError(C.DEVICE_NVR_CHANNEL_INVALID, "無法組裝即時 RTSP URL");
    }

    const pathName = pathNameLive(nvrId, proxyId);
    const playback = mediaMTXService.buildWebrtcPlayback(pathName);
    const items = await mediaMTXService.listPaths();
    if (items.some((p) => p.name === pathName)) {
      logger.debug("NVR 通道串流已在運行，略過重啟", { nvrId, proxyId, pathName });
      return {
        streamId: pathName,
        pathName,
        webrtcUrl: playback.webrtcUrl,
        webrtcPort: playback.webrtcPort,
        status: "running",
        proxyChannelId: proxyId,
      };
    }

    await mediaMTXService.addPath(pathName, rtspUrl);
    logger.info("NVR 通道串流已啟動", {
      nvrId,
      proxyId,
      pathName,
      rtspUrl: nvrIsapiService.maskRtspUrl(rtspUrl),
    });
    return {
      streamId: pathName,
      pathName,
      webrtcUrl: playback.webrtcUrl,
      webrtcPort: playback.webrtcPort,
      status: "running",
      proxyChannelId: proxyId,
    };
  })();

  liveStartInFlight.set(key, task);
  try {
    return await task;
  } finally {
    liveStartInFlight.delete(key);
  }
}

/**
 * 與一般攝影機 stop 一致：不 removePath，避免 MediaMTX reload
 */
async function stopChannelStream(nvrId, proxyChannelId) {
  const proxyId = Number(proxyChannelId);
  if (!Number.isFinite(proxyId) || proxyId <= 0) {
    throw createApiError(C.DEVICE_NVR_CHANNEL_INVALID, "proxyChannelId 無效");
  }
  await getNvrDevice(nvrId);
  return {
    message: "串流已標記停止（path 保留）",
    pathName: pathNameLive(nvrId, proxyId),
  };
}

async function searchRecordings(nvrId, body) {
  const device = await getNvrDevice(nvrId);
  const result = await nvrIsapiService.searchRecordings(device.config, {
    trackId: body?.trackId ?? body?.track_id,
    start: body?.startTime ?? body?.start_time ?? body?.start,
    end: body?.endTime ?? body?.end_time ?? body?.end,
    maxResults: body?.maxResults ?? body?.max_results,
  });
  return { nvrId, ...result };
}

function schedulePlaybackExpiry(sessionId) {
  const session = playbackSessions.get(sessionId);
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  const delay = Math.max(0, session.expiresAt - Date.now());
  session.timer = setTimeout(() => {
    stopPlayback(session.nvrId, sessionId).catch((err) => {
      logger.warn("NVR 回放 TTL 清理失敗", {
        sessionId,
        error: err?.message || String(err),
      });
    });
  }, delay);
  if (typeof session.timer.unref === "function") session.timer.unref();
}

async function startPlayback(nvrId, body) {
  const device = await getNvrDevice(nvrId);
  const conn = nvrIsapiService.resolveNvrConnection(device.config);
  let playbackURI = String(body?.playbackURI || body?.playback_uri || "").trim();

  if (!playbackURI) {
    const searched = await nvrIsapiService.searchRecordings(device.config, {
      trackId: body?.trackId ?? body?.track_id,
      start: body?.startTime ?? body?.start_time ?? body?.start,
      end: body?.endTime ?? body?.end_time ?? body?.end,
      maxResults: 1,
    });
    playbackURI = String(searched.matches?.[0]?.playbackURI || "").trim();
  }

  if (!playbackURI.toLowerCase().startsWith("rtsp://")) {
    throw createApiError(
      C.DEVICE_NVR_PLAYBACK_URI_MISSING,
      "缺少有效的 playbackURI",
    );
  }

  const rtspUrl = nvrIsapiService.injectRtspAuth(
    playbackURI,
    conn.username,
    conn.password,
  );
  const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const pathName = pathNamePlayback(nvrId, sessionId);

  await mediaMTXService.addPath(pathName, rtspUrl);
  const webrtc = mediaMTXService.buildWebrtcPlayback(pathName);
  const expiresAt = Date.now() + PLAYBACK_TTL_MS;
  playbackSessions.set(sessionId, {
    pathName,
    nvrId,
    expiresAt,
    timer: null,
  });
  schedulePlaybackExpiry(sessionId);

  logger.info("NVR 回放已啟動", {
    nvrId,
    sessionId,
    pathName,
    rtspUrl: nvrIsapiService.maskRtspUrl(rtspUrl),
  });

  return {
    sessionId,
    pathName,
    webrtcUrl: webrtc.webrtcUrl,
    webrtcPort: webrtc.webrtcPort,
    expiresAt: new Date(expiresAt).toISOString(),
    status: "running",
  };
}

async function stopPlayback(nvrId, sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) {
    throw createApiError(
      C.DEVICE_NVR_PLAYBACK_SESSION_NOT_FOUND,
      "缺少 playback sessionId",
    );
  }
  const session = playbackSessions.get(sid);
  const pathName =
    session && session.nvrId === Number(nvrId)
      ? session.pathName
      : pathNamePlayback(nvrId, sid);
  if (session?.timer) clearTimeout(session.timer);
  playbackSessions.delete(sid);
  await mediaMTXService.removePath(pathName);
  logger.info("NVR 回放已停止", { nvrId, sessionId: sid, pathName });
  return { message: "回放已停止", sessionId: sid };
}

module.exports = {
  listChannels,
  startChannelStream,
  stopChannelStream,
  searchRecordings,
  startPlayback,
  stopPlayback,
  pathNameLive,
  pathNamePlayback,
  PLAYBACK_TTL_MS,
};
