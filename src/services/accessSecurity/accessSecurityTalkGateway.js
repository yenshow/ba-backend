/**
 * YSOP 網頁對講：瀏覽器 PCM ↔ Socket.IO ↔ SIP/RTP（G.711 sendrecv）
 * 不經管理中心主機、不播警報音檔、非 MediaMTX／非完整 WebRTC 棧。
 */
const { createLogger } = require("../../utils/logger");
const licenseService = require("../license/licenseService");
const operationalEventService = require("../operationalEvents/operationalEventService");
const { summaryIntercom } = require("../operationalEvents/operationalEventCopy");
const accessSecurityService = require("./accessSecurityService");
const { beginIndoorTalk } = require("./sipInviteService");
const {
  encodePcm16leFrame,
  decodeG711Frame,
  FRAME_BYTES,
} = require("./g711Audio");

const logger = createLogger("accessSecurityTalk");

const RING_PERMISSION = "system.access_security.ring";
const TALK_MAX_MS = 5 * 60 * 1000;
const TALK_ANSWER_MS = 90_000;
const RTP_INTERVAL_MS = 20;
const SILENCE_GAP_MS = 40;

const EVENT_START = "access-security:talk:start";
const EVENT_PCM = "access-security:talk:pcm";
const EVENT_HANGUP = "access-security:talk:hangup";
const EVENT_STATUS = "access-security:talk:status";

/** @type {Map<string, object>} */
const sessionsBySocketId = new Map();

const hasPermission = (socket, code) => {
  const codes = Array.isArray(socket?.data?.permissions)
    ? socket.data.permissions
    : [];
  return codes.includes(code);
};

const toBuffer = (data) => {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data.type === "Buffer" && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  return null;
};

const emitStatus = (socket, payload) => {
  try {
    socket.emit(EVENT_STATUS, payload);
  } catch {
    /* ignore */
  }
};

const recordTalkEvent = async ({
  locationId,
  locationName,
  systemId,
  deviceId,
  actorUserId,
  action,
  invite,
  durationMs,
  reason,
}) => {
  try {
    await operationalEventService.recordEvent({
      source: "access_security_talk",
      event_kind: "intercom",
      location_id: locationId,
      system_id: systemId,
      device_id: deviceId,
      message: summaryIntercom({
        placeLabel: locationName || String(locationId),
        action,
      }),
      actor_user_id: actorUserId,
      payload: {
        layer: 2,
        callType: "talk",
        invite: invite || null,
        durationMs: durationMs || 0,
        reason: reason || null,
      },
    });
  } catch (err) {
    logger.warn("網頁對講營運事件寫入失敗", {
      locationId,
      error: err?.message || String(err),
    });
  }
};

const endSession = async (socketId, reason) => {
  const entry = sessionsBySocketId.get(socketId);
  if (!entry || entry.ending) return;
  entry.ending = true;
  if (entry.silenceTimer) {
    clearInterval(entry.silenceTimer);
    entry.silenceTimer = null;
  }
  if (entry.maxTimer) {
    clearTimeout(entry.maxTimer);
    entry.maxTimer = null;
  }
  sessionsBySocketId.delete(socketId);

  const durationMs = entry.answeredAt
    ? Date.now() - entry.answeredAt
    : 0;
  try {
    await entry.session?.hangup?.();
  } catch (err) {
    logger.warn("網頁對講掛斷失敗", {
      socketId,
      error: err?.message || String(err),
    });
  }

  const socket = entry.socket;
  if (socket?.connected) {
    emitStatus(socket, {
      phase: "ended",
      locationId: entry.locationId,
      reason,
    });
  }

  let action = "網頁對講結束";
  if (reason === "no-answer") action = "網頁對講未接聽";
  else if (reason === "error") action = "網頁對講失敗";
  else if (!entry.answeredAt) action = "網頁對講未接聽";

  await recordTalkEvent({
    locationId: entry.locationId,
    locationName: entry.locationName,
    systemId: entry.systemId,
    deviceId: entry.deviceId,
    actorUserId: entry.actorUserId,
    action,
    invite: entry.invite || null,
    durationMs,
    reason,
  });
};

const startSilenceKeepalive = (entry) => {
  const pt = entry.session?.result?.remoteSdp?.payloadType === 8 ? 8 : 0;
  const fill = pt === 8 ? 0xd5 : 0xff;
  const silence = Buffer.alloc(FRAME_BYTES, fill);
  entry.silenceTimer = setInterval(() => {
    if (entry.ending) return;
    if (Date.now() - (entry.lastMicAt || 0) < SILENCE_GAP_MS) return;
    try {
      entry.session.sendPcmuFrame(silence);
    } catch {
      /* ignore */
    }
  }, RTP_INTERVAL_MS);
};

const handleStart = async (socket, payload) => {
  const socketId = socket.id;
  const locationId = Number(payload?.locationId);
  if (!Number.isFinite(locationId) || locationId <= 0) {
    emitStatus(socket, { phase: "error", message: "戶別無效" });
    return;
  }
  if (!socket.data?.sessionLog?.permReady) {
    await new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (socket.data?.sessionLog?.permReady || Date.now() - started >= 2500) {
          resolve();
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }
  if (sessionsBySocketId.has(socketId)) {
    emitStatus(socket, { phase: "error", locationId, message: "已有對講進行中" });
    return;
  }
  if (!hasPermission(socket, RING_PERMISSION)) {
    emitStatus(socket, { phase: "error", locationId, message: "沒有對講權限" });
    return;
  }

  const licensed = await licenseService.isRuntimeFeatureLicensed("access_security");
  if (!licensed) {
    emitStatus(socket, { phase: "error", locationId, message: "未授權門禁保全" });
    return;
  }

  let resolved;
  try {
    resolved = await accessSecurityService.resolveIndoorDeviceForLocation(locationId);
  } catch (err) {
    emitStatus(socket, {
      phase: "error",
      locationId,
      message: err?.message || "室內機不存在",
    });
    return;
  }

  logger.info("網頁對講撥號", {
    locationId,
    deviceId: Number(resolved.device.id),
  });

  let live;
  try {
    live = await beginIndoorTalk(resolved.device, { answerMs: TALK_ANSWER_MS });
  } catch (err) {
    logger.warn("網頁對講撥號失敗", {
      locationId,
      error: err?.message || String(err),
    });
    emitStatus(socket, {
      phase: "error",
      locationId,
      message: err?.message || "對講撥號失敗",
    });
    return;
  }

  const entry = {
    socket,
    session: { hangup: live.hangup },
    locationId: resolved.locationId,
    locationName: resolved.locationName,
    systemId: resolved.systemId,
    deviceId: Number(resolved.device.id),
    actorUserId: socket.data?.userId ?? null,
    invite: null,
    answeredAt: null,
    lastMicAt: 0,
    silenceTimer: null,
    maxTimer: null,
    ending: false,
  };
  sessionsBySocketId.set(socketId, entry);
  live.setOnRemoteBye(() => {
    void endSession(socketId, "remote-bye");
  });
  emitStatus(socket, { phase: "ringing", locationId });

  let session;
  try {
    session = await live.waitAnswered();
  } catch (err) {
    if (!entry.ending) {
      emitStatus(socket, {
        phase: "error",
        locationId,
        message: err?.message || "對講撥號失敗",
      });
    }
    await endSession(socketId, "error");
    return;
  }

  if (entry.ending) return;
  entry.session = session;
  entry.invite = session.result;
  entry.deviceId = session.deviceId || entry.deviceId;
  logger.info("網頁對講 SIP 結果", {
    locationId,
    deviceId: entry.deviceId,
    statusCode: session.result?.statusCode || null,
    answered: Boolean(session.answered),
  });

  if (!session.answered) {
    await endSession(socketId, "no-answer");
    return;
  }

  entry.answeredAt = Date.now();
  session.setOnInbound?.(({ payload: g711, payloadType }) => {
    if (entry.ending || !socket.connected) return;
    const pt = payloadType === 8 ? 8 : 0;
    const pcm = decodeG711Frame(g711, pt);
    try {
      socket.emit(EVENT_PCM, pcm);
    } catch {
      /* ignore */
    }
  });
  startSilenceKeepalive(entry);
  entry.maxTimer = setTimeout(() => {
    void endSession(socketId, "timeout");
  }, TALK_MAX_MS);

  emitStatus(socket, {
    phase: "answered",
    locationId: entry.locationId,
    deviceId: entry.deviceId,
  });
};

const handlePcm = (socket, data) => {
  const entry = sessionsBySocketId.get(socket.id);
  if (!entry || entry.ending || !entry.answeredAt) return;
  const pcm = toBuffer(data);
  if (!pcm || pcm.length < 2) return;
  const pt = entry.session?.result?.remoteSdp?.payloadType === 8 ? 8 : 0;
  try {
    entry.session.sendPcmuFrame?.(encodePcm16leFrame(pcm, pt));
    entry.lastMicAt = Date.now();
  } catch {
    /* ignore */
  }
};

const attachTalkHandlers = (socket) => {
  socket.on(EVENT_START, (payload) => {
    void handleStart(socket, payload || {});
  });
  socket.on(EVENT_PCM, (data) => {
    handlePcm(socket, data);
  });
  socket.on(EVENT_HANGUP, () => {
    void endSession(socket.id, "client");
  });
  socket.on("disconnect", () => {
    void endSession(socket.id, "disconnect");
  });
};

module.exports = {
  attachTalkHandlers,
};
