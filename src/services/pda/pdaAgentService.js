/**
 * PDA Agent（Socket.IO /pda-agent）：常駐 APK 連線，供中控主動警報／停止。
 */
const logger = require("../../utils/logger").createLogger("PDA Agent");
const config = require("../../config");
const crypto = require("crypto");

/** @type {import('socket.io').Namespace | null} */
let nsp = null;
/** deviceCode -> socket */
const agents = new Map();

const DEFAULT_ALARM_MS = 120_000;
const MAX_ALARM_MS = 120_000;
const MIN_ALARM_MS = 3_000;

const timingSafeEqualString = (a, b) => {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
};

const normalizeDurationMs = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULT_ALARM_MS;
  }
  return Math.min(MAX_ALARM_MS, Math.max(MIN_ALARM_MS, Math.trunc(n)));
};

const listOnline = () =>
  Array.from(agents.entries()).map(([deviceCode, socket]) => ({
    deviceCode,
    socketId: socket.id,
    connectedAt: socket.data?.connectedAt || null,
  }));

const isOnline = (deviceCode) => agents.has(String(deviceCode || "").trim());

/**
 * @param {import('socket.io').Server} io
 */
const attach = (io) => {
  if (!io || nsp) {
    return nsp;
  }
  nsp = io.of("/pda-agent");
  nsp.on("connection", (socket) => {
    const auth = socket.handshake?.auth || {};
    const deviceCode = String(auth.deviceCode || "").trim();
    const key = String(auth.key || "").trim();
    const expected = config.pda?.agentKey || "";

    if (!deviceCode || !expected || !timingSafeEqualString(key, expected)) {
      logger.warn("PDA Agent 連線拒絕", { deviceCode, socketId: socket.id });
      socket.emit("error", { message: "裝置金鑰錯誤或未設定 PDA_AGENT_KEY" });
      socket.disconnect(true);
      return;
    }

    const prev = agents.get(deviceCode);
    if (prev && prev.id !== socket.id) {
      try {
        prev.disconnect(true);
      } catch {
        /* ignore */
      }
    }

    socket.data.deviceCode = deviceCode;
    socket.data.connectedAt = new Date().toISOString();
    agents.set(deviceCode, socket);
    logger.info("PDA Agent 上線", { deviceCode, socketId: socket.id });
    socket.emit("helloAck", { ok: true, deviceCode });

    socket.on("ping", () => {
      socket.emit("pong", { t: Date.now() });
    });

    socket.on("beepAck", (payload) => {
      const pending = socket.data.pendingBeep;
      if (!pending) {
        return;
      }
      if (payload?.requestId && payload.requestId !== pending.requestId) {
        return;
      }
      clearTimeout(pending.timer);
      socket.data.pendingBeep = null;
      pending.resolve({
        ok: Boolean(payload?.ok),
        deviceId: deviceCode,
        method: "pda-agent",
        message: payload?.ok
          ? `PDA App 已開始警報（${pending.durationMs}ms）`
          : "PDA App 警報失敗",
        requestId: pending.requestId,
        durationMs: pending.durationMs,
      });
    });

    socket.on("beepStopAck", (payload) => {
      const pending = socket.data.pendingBeepStop;
      if (!pending) {
        return;
      }
      if (payload?.requestId && payload.requestId !== pending.requestId) {
        return;
      }
      clearTimeout(pending.timer);
      socket.data.pendingBeepStop = null;
      pending.resolve({
        ok: Boolean(payload?.ok !== false),
        deviceId: deviceCode,
        method: "pda-agent",
        message: "PDA App 已停止警報",
        requestId: pending.requestId,
      });
    });

    socket.on("disconnect", () => {
      if (agents.get(deviceCode)?.id === socket.id) {
        agents.delete(deviceCode);
      }
      const pending = socket.data.pendingBeep;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("PDA Agent 已斷線"));
        socket.data.pendingBeep = null;
      }
      const pendingStop = socket.data.pendingBeepStop;
      if (pendingStop) {
        clearTimeout(pendingStop.timer);
        pendingStop.reject(new Error("PDA Agent 已斷線"));
        socket.data.pendingBeepStop = null;
      }
      logger.info("PDA Agent 離線", { deviceCode, socketId: socket.id });
    });
  });
  logger.info("PDA Agent namespace 已掛載", { path: "/pda-agent" });
  return nsp;
};

const beep = ({ deviceCode, durationMs } = {}) => {
  const code = String(deviceCode || "").trim();
  if (!code) {
    return Promise.reject(new Error("缺少 deviceCode"));
  }
  const socket = agents.get(code);
  if (!socket) {
    return Promise.reject(new Error(`PDA App 未連線：${code}`));
  }

  const ms = normalizeDurationMs(durationMs);
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (socket.data.pendingBeep?.requestId === requestId) {
        socket.data.pendingBeep = null;
      }
      reject(new Error("PDA App 警報逾時"));
    }, 5000);
    socket.data.pendingBeep = { requestId, timer, resolve, reject, durationMs: ms };
    socket.emit("beep", { requestId, durationMs: ms });
  });
};

const stopBeep = ({ deviceCode } = {}) => {
  const code = String(deviceCode || "").trim();
  if (!code) {
    return Promise.reject(new Error("缺少 deviceCode"));
  }
  const socket = agents.get(code);
  if (!socket) {
    return Promise.reject(new Error(`PDA App 未連線：${code}`));
  }

  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (socket.data.pendingBeepStop?.requestId === requestId) {
        socket.data.pendingBeepStop = null;
      }
      reject(new Error("PDA App 停止警報逾時"));
    }, 5000);
    socket.data.pendingBeepStop = { requestId, timer, resolve, reject };
    socket.emit("beepStop", { requestId });
  });
};

module.exports = {
  attach,
  beep,
  stopBeep,
  listOnline,
  isOnline,
  DEFAULT_ALARM_MS,
  MAX_ALARM_MS,
  MIN_ALARM_MS,
};
