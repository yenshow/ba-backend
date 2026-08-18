/**
 * 層 2：直打室內機 SIP
 * - ring：只振鈴（180 後 CANCEL；200 立刻 BYE，無 RTP）
 * - broadcast：等待接聽（200）→ 單向 RTP 播放 G.711 音檔 → BYE
 */
const dgram = require("dgram");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");
const C = require("../../utils/apiErrorCodes");
const config = require("../../config");
const { createApiError } = require("../../utils/apiErrors");
const { createLogger } = require("../../utils/logger");
const { loadG711FramesFromFile } = require("./g711Audio");
const { createRtpSender } = require("./rtpSender");

const logger = createLogger("sipInvite");

const DEFAULT_HOLD_MS = 20_000;
const DEFAULT_ANSWER_MS = 45_000;
const DEFAULT_FROM_USER = "2001";
const DEFAULT_DISPLAY_NAME = "BA-Platform";

/** @type {Map<number, Promise<unknown>>} */
const ringingByDeviceId = new Map();

/** @type {{ path: string, mtimeMs: number, byPt: Record<number, { payloadType: 0|8, frames: Buffer[], durationMs: number }> } | null} */
let cachedBroadcastAudio = null;

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const branchId = () => `z9hG4bK${crypto.randomBytes(6).toString("hex")}`;
const tagId = () => crypto.randomBytes(4).toString("hex");
const callIdNew = (host) => `${crypto.randomBytes(8).toString("hex")}@${host}`;

const pickLocalIpv4 = () => {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "127.0.0.1";
};

const parseSipMessage = (buf) => {
  const raw = buf.toString("utf8");
  const parts = raw.split("\r\n\r\n");
  const head = parts[0] || "";
  const body = parts.slice(1).join("\r\n\r\n");
  const lines = head.split("\r\n");
  const start = lines[0] || "";
  const headers = {};
  for (let i = 1; i < lines.length; i += 1) {
    const idx = lines[i].indexOf(":");
    if (idx < 0) continue;
    headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i]
      .slice(idx + 1)
      .trim();
  }
  const statusCode = start.startsWith("SIP/2.0 ")
    ? Number(start.split(/\s+/)[1]) || null
    : null;
  return { raw, start, headers, statusCode, body };
};

const parseAnswerSdp = (body, fallbackHost) => {
  const text = String(body || "");
  const connMatch = text.match(/c=IN IP4 ([^\s\r\n]+)/i);
  const mediaMatch = text.match(/m=audio (\d+) RTP\/AVP(?: (.+))?/i);
  let payloadType = 0;
  if (mediaMatch?.[2]) {
    const pts = mediaMatch[2].split(/\s+/).map(Number);
    if (pts.includes(8) && !pts.includes(0)) payloadType = 8;
    else if (!pts.includes(0) && pts[0]) payloadType = pts[0];
  }
  return {
    remoteIp: connMatch?.[1] || fallbackHost,
    remotePort: mediaMatch ? Number(mediaMatch[1]) : null,
    payloadType: payloadType === 8 ? 8 : 0,
  };
};

const parseWwwAuthenticate = (header) => {
  if (!header) return null;
  const out = { scheme: "Digest" };
  const m = header.match(/Digest\s+(.*)/i);
  const body = m ? m[1] : header;
  for (const part of body.split(",")) {
    const kv = part.trim().match(/^(\w+)=(?:"([^"]*)"|([^,\s]*))$/);
    if (!kv) continue;
    out[kv[1].toLowerCase()] = kv[2] != null ? kv[2] : kv[3];
  }
  return out;
};

const buildDigestAuth = ({ username, password, method, uri, auth }) => {
  const realm = auth.realm || "";
  const nonce = auth.nonce || "";
  const qop = (auth.qop || "").split(",")[0].trim();
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  let response;
  let cnonce;
  let nc;
  if (qop === "auth" || qop === "auth-int") {
    cnonce = crypto.randomBytes(8).toString("hex");
    nc = "00000001";
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5`;
  if (auth.opaque) header += `, opaque="${auth.opaque}"`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  return header;
};

const isProvisional = (code) => Number.isInteger(code) && code >= 100 && code < 200;

const classify = (code) => {
  if (code === 200) return "ok";
  if (code === 401 || code === 407) return "need-auth";
  if (code === 403) return "forbidden";
  if (code === 404) return "not-found";
  if (code === 100 || code === 101) return "trying";
  if (code === 180 || code === 183) return "ringing";
  if (code === 486) return "busy";
  if (isProvisional(code)) return "trying";
  return code ? `code-${code}` : "none";
};

const resolveBroadcastAudioPath = (overridePath) => {
  const configured =
    overridePath ||
    config.accessSecurity?.alertAudioPath ||
    path.resolve(process.cwd(), "assets", "access-security", "alert-broadcast.pcm");
  return path.resolve(String(configured));
};

const loadBroadcastAudio = (overridePath, payloadType = 0) => {
  const abs = resolveBroadcastAudioPath(overridePath);
  const pt = payloadType === 8 ? 8 : 0;
  const mtimeMs = fs.existsSync(abs) ? fs.statSync(abs).mtimeMs : 0;
  if (
    cachedBroadcastAudio?.path !== abs ||
    cachedBroadcastAudio?.mtimeMs !== mtimeMs
  ) {
    cachedBroadcastAudio = { path: abs, mtimeMs, byPt: {} };
  }
  if (!cachedBroadcastAudio.byPt[pt]) {
    cachedBroadcastAudio.byPt[pt] = loadG711FramesFromFile(abs, { payloadType: pt });
  }
  return cachedBroadcastAudio.byPt[pt];
};

const isAlertBroadcastConfigured = () => {
  if (config.accessSecurity?.alertBroadcastEnabled === false) return false;
  const abs = resolveBroadcastAudioPath();
  return fs.existsSync(abs);
};

class SipProbe {
  constructor(cfg) {
    this.config = cfg;
    this.socket = dgram.createSocket("udp4");
    this.localIp = pickLocalIpv4();
    this.localPort = 0;
    this.cseq = 1;
    this.fromTag = tagId();
    this.callId = null;
    this.inviteBranch = null;
    this.waiters = [];
    this.inbox = [];
    this.silent = Boolean(cfg.silent);
    this.mode = cfg.mode === "broadcast" ? "broadcast" : "ring";
    this.rtpLocalPort = 0;
    this.audio = cfg.audio || null;
    this.audioPath = cfg.audioPath || null;
    this.rtp = null;
  }

  log(...args) {
    if (!this.silent) {
      // eslint-disable-next-line no-console
      console.log(...args);
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.on("message", (msg, rinfo) => {
        const parsed = parseSipMessage(msg);
        this.log(
          `\n<< ${rinfo.address}:${rinfo.port}\n${parsed.raw.slice(0, 1200)}\n`,
        );
        if (this.waiters.length > 0) {
          const pending = [...this.waiters];
          this.waiters = [];
          for (const w of pending) w.resolve(parsed);
        } else {
          this.inbox.push(parsed);
        }
      });
      this.socket.bind(0, () => {
        this.localPort = this.socket.address().port;
        this.log(
          `本機 UDP ${this.localIp}:${this.localPort} → ${this.config.sipHost}:${this.config.sipPort}`,
        );
        // 振鈴也給真實 RTP 埠，避免 SDP `m=audio 0` 被室內機拒絕
        this.rtp = createRtpSender({ localIp: this.localIp });
        this.rtp
          .start()
          .then(() => {
            this.rtpLocalPort = this.rtp.localPort;
            this.log(`本機 RTP ${this.localIp}:${this.rtpLocalPort}`);
            resolve();
          })
          .catch(reject);
      });
    });
  }

  close() {
    try {
      this.rtp?.close();
    } catch {
      /* ignore */
    }
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }

  send(raw) {
    this.log(
      `\n>> ${this.config.sipHost}:${this.config.sipPort}\n${raw.slice(0, 1200)}\n`,
    );
    return new Promise((resolve, reject) => {
      this.socket.send(
        Buffer.from(raw, "utf8"),
        this.config.sipPort,
        this.config.sipHost,
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  waitOne(timeoutMs) {
    if (this.inbox.length > 0) {
      return Promise.resolve(this.inbox.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`等待 SIP 回應逾時（${timeoutMs}ms）`));
      }, timeoutMs);
      this.waiters.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });
  }

  buildMessage(method, { requestUri, toUser, authHeader, body, toTag, branch }) {
    const host = this.config.sipHost;
    const cseq = this.cseq;
    this.cseq += 1;
    if (!this.callId) this.callId = callIdNew(this.localIp);
    const viaBranch = branch || branchId();
    const contact = `sip:${this.config.sipUser}@${this.localIp}:${this.localPort}`;
    const to = toTag
      ? `<sip:${toUser}@${host}>;tag=${toTag}`
      : `<sip:${toUser}@${host}>`;
    const lines = [
      `${method} ${requestUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};rport;branch=${viaBranch}`,
      "Max-Forwards: 70",
      `From: "${this.config.displayName}" <sip:${this.config.sipUser}@${host}>;tag=${this.fromTag}`,
      `To: ${to}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: <${contact}>`,
      "User-Agent: BA-System-SIP/1.0",
      "Allow: INVITE, ACK, CANCEL, BYE, OPTIONS",
    ];
    if (authHeader) lines.push(`Authorization: ${authHeader}`);
    const payload = body || "";
    if (payload) lines.push("Content-Type: application/sdp");
    lines.push(`Content-Length: ${Buffer.byteLength(payload, "utf8")}`);
    lines.push("");
    lines.push(payload);
    return lines.join("\r\n");
  }

  buildOfferSdp() {
    return [
      "v=0",
      `o=${this.config.sipUser} ${Date.now()} ${Date.now()} IN IP4 ${this.localIp}`,
      "s=BA Alert Broadcast",
      `c=IN IP4 ${this.localIp}`,
      "t=0 0",
      `m=audio ${this.rtpLocalPort} RTP/AVP 0 8 101`,
      "a=rtpmap:0 PCMU/8000",
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:101 telephone-event/8000",
      "a=sendonly",
      "",
    ].join("\r\n");
  }

  extractToTag(resp) {
    const toTagMatch = (resp.headers.to || "").match(/;tag=([^;>\s]+)/i);
    return toTagMatch ? toTagMatch[1] : undefined;
  }

  async sendAckBye(requestUri, toUser, toTag) {
    await this.send(
      this.buildMessage("ACK", {
        requestUri,
        toUser,
        toTag,
      }),
    );
    await this.send(
      this.buildMessage("BYE", {
        requestUri,
        toUser,
        toTag,
      }),
    );
  }

  async playRtp(remoteIp, remotePort, payloadType) {
    if (!this.rtp) throw new Error("RTP 未啟動");
    const pt = payloadType === 8 ? 8 : 0;
    const audio =
      this.audio?.payloadType === pt && this.audio?.frames?.length
        ? this.audio
        : loadBroadcastAudio(this.audioPath, pt);
    if (!audio?.frames?.length) throw new Error("未載入廣播音訊");
    await this.rtp.sendFrames(audio.frames, {
      remoteIp,
      remotePort,
      payloadType: pt,
    });
    return { playDurationMs: audio.durationMs, frameCount: audio.frames.length };
  }

  async sendCancel(requestUri, toUser) {
    await this.send(
      this.buildMessage("CANCEL", {
        requestUri,
        toUser,
        branch: this.inviteBranch,
      }),
    );
  }

  async waitUntilAnswerOrTimeout(resp, requestUri, toUser, answerMs) {
    let current = resp;
    if (current.statusCode === 200) return current;

    const deadline = Date.now() + answerMs;
    while (Date.now() < deadline) {
      if (current.statusCode === 200) return current;
      if (!isProvisional(current.statusCode)) return current;
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      try {
        current = await this.waitOne(Math.min(3000, remain));
      } catch {
        // 振鈴中可能長時間沒有新 SIP 訊息，繼續等到接聽或總時限
        this.log(`等待接聽中… 剩餘 ${Math.ceil(remain / 1000)}s`);
      }
    }

    if (current.statusCode === 200) return current;
    if (isProvisional(current.statusCode)) {
      try {
        await this.sendCancel(requestUri, toUser);
      } catch (err) {
        logger.warn("SIP CANCEL 失敗", { error: err?.message || String(err) });
      }
    }
    return current;
  }

  async invite() {
    this.callId = callIdNew(this.localIp);
    this.fromTag = tagId();
    const requestUri = `sip:${this.config.targetUser}@${this.config.sipHost}:${this.config.sipPort}`;
    this.inviteBranch = branchId();
    const inviteOpts = {
      requestUri,
      toUser: this.config.targetUser,
      body: this.buildOfferSdp(),
      branch: this.inviteBranch,
    };

    await this.send(this.buildMessage("INVITE", inviteOpts));
    const firstWaitMs =
      this.mode === "broadcast"
        ? Math.max(5000, this.config.answerMs || DEFAULT_ANSWER_MS)
        : Math.max(5000, this.config.holdMs);
    let resp = await this.waitOne(firstWaitMs);

    if (resp.statusCode === 401 || resp.statusCode === 407) {
      const hdr =
        resp.headers["www-authenticate"] || resp.headers["proxy-authenticate"];
      const auth = parseWwwAuthenticate(hdr);
      if (!auth) throw new Error("收到 401/407 但無法解析 Digest");
      await this.send(
        this.buildMessage("INVITE", {
          ...inviteOpts,
          authHeader: buildDigestAuth({
            username: this.config.sipUser,
            password: this.config.password,
            method: "INVITE",
            uri: requestUri,
            auth,
          }),
        }),
      );
      resp = await this.waitOne(firstWaitMs);
    }

    if (this.mode === "broadcast") {
      resp = await this.waitUntilAnswerOrTimeout(
        resp,
        requestUri,
        this.config.targetUser,
        Math.max(5000, this.config.answerMs || DEFAULT_ANSWER_MS),
      );

      if (resp.statusCode === 200) {
        const toTag = this.extractToTag(resp);
        const sdp = parseAnswerSdp(resp.body, this.config.sipHost);
        if (!sdp.remotePort) {
          throw new Error("200 OK SDP 缺少 audio port");
        }
        let played = null;
        try {
          await this.send(
            this.buildMessage("ACK", {
              requestUri,
              toUser: this.config.targetUser,
              toTag,
            }),
          );
          played = await this.playRtp(sdp.remoteIp, sdp.remotePort, sdp.payloadType);
          await this.send(
            this.buildMessage("BYE", {
              requestUri,
              toUser: this.config.targetUser,
              toTag,
            }),
          );
        } catch (err) {
          logger.warn("SIP 廣播播放失敗", { error: err?.message || String(err) });
          try {
            await this.sendByeIfPossible(requestUri, this.config.targetUser, toTag);
          } catch {
            /* ignore */
          }
          resp._playError = err?.message || String(err);
        }
        resp._played = played;
        return resp;
      }
      return resp;
    }

    // ring：振鈴 holdMs 後 CANCEL（200 則立刻掛斷、不播放）
    const deadline = Date.now() + this.config.holdMs;
    while (Date.now() < deadline && isProvisional(resp.statusCode)) {
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      try {
        resp = await this.waitOne(Math.min(3000, remain));
      } catch {
        /* 振鈴中無新訊息屬正常 */
      }
    }

    if (resp.statusCode === 200) {
      const toTag = this.extractToTag(resp);
      try {
        await this.sendAckBye(requestUri, this.config.targetUser, toTag);
      } catch (err) {
        logger.warn("SIP ACK/BYE 失敗", { error: err?.message || String(err) });
      }
      return resp;
    }

    if (isProvisional(resp.statusCode)) {
      try {
        await this.sendCancel(requestUri, this.config.targetUser);
      } catch (err) {
        logger.warn("SIP CANCEL 失敗", { error: err?.message || String(err) });
      }
    }

    return resp;
  }

  async sendByeIfPossible(requestUri, toUser, toTag) {
    if (!toTag) return;
    await this.send(
      this.buildMessage("BYE", {
        requestUri,
        toUser,
        toTag,
      }),
    );
  }
}

const buildInviteResult = (inv, host, mode) => {
  const result = classify(inv.statusCode);
  const contact = inv.headers?.contact || "";
  const contactOk = !contact || contact.includes(host);
  const played = inv._played || null;
  const playError = inv._playError || null;
  const broadcastOk = mode === "broadcast" && Boolean(played);
  return {
    ok: broadcastOk || result === "ringing" || (mode === "ring" && result === "ok"),
    result: broadcastOk ? "broadcast-played" : result,
    statusCode: inv.statusCode,
    startLine: inv.start,
    contactOk,
    contact,
    mode,
    played: Boolean(played),
    playDurationMs: played?.playDurationMs ?? 0,
    playError,
  };
};

const runSipSession = async (opts, mode) => {
  const host = String(opts?.host || "").trim();
  const voipNumber = String(opts?.voipNumber || "").trim();
  const username = String(opts?.username || "").trim() || DEFAULT_FROM_USER;
  const password = String(opts?.password || "");
  const sipPort = Number(opts?.sipPort) > 0 ? Number(opts.sipPort) : 5060;
  if (!host || !voipNumber) {
    throw createApiError(
      C.LOCATION_DEVICE_NOT_FOUND,
      "室內機缺少 host 或 voipNumber",
    );
  }

  const probe = new SipProbe({
    sipHost: host,
    sipPort,
    sipUser: username,
    password,
    targetUser: voipNumber,
    displayName: opts?.displayName || DEFAULT_DISPLAY_NAME,
    holdMs: Number(opts?.holdMs) > 0 ? Number(opts.holdMs) : DEFAULT_HOLD_MS,
    answerMs:
      Number(opts?.answerMs) > 0
        ? Number(opts.answerMs)
        : config.accessSecurity?.alertAnswerMs || DEFAULT_ANSWER_MS,
    silent: opts?.silent !== false,
    mode,
    audio: mode === "broadcast" ? opts.audio : null,
    audioPath: opts?.audioPath || opts?.audioFilePath || null,
  });

  try {
    await probe.start();
    const inv = await probe.invite();
    return buildInviteResult(inv, host, mode);
  } finally {
    probe.close();
  }
};

/**
 * 只振鈴（既有行為）
 */
async function inviteIndoorRing(opts) {
  return runSipSession(opts, "ring");
}

/**
 * 等待接聽後單向播放 G.711 音檔
 * @param {object} opts 同 inviteIndoorRing，另可傳 audioPath 或 audio
 */
async function inviteIndoorBroadcast(opts) {
  const audio =
    opts?.audio ||
    loadBroadcastAudio(opts?.audioPath || opts?.audioFilePath);
  return runSipSession({ ...opts, audio }, "broadcast");
}

const parseDeviceConfig = (device) => {
  if (typeof device?.config === "string") {
    try {
      return JSON.parse(device.config);
    } catch {
      return {};
    }
  }
  return device?.config || {};
};

const assertIndoorDevice = (device, cfg) => {
  const deviceId = Number(device?.id);
  if (!Number.isFinite(deviceId) || deviceId <= 0) {
    throw createApiError(C.LOCATION_DEVICE_NOT_FOUND, "室內機設備不存在");
  }
  if (ringingByDeviceId.has(deviceId)) {
    throw createApiError(C.CONFLICT, "該室內機正在語音廣播中，請稍後再試");
  }
  const unitType = String(cfg.unitType || "").trim();
  if (unitType !== "indoor") {
    throw createApiError(
      C.DEVICE_CONFIG_INVALID,
      "僅可對 unitType=indoor 的室內機發送 SIP",
    );
  }
  return deviceId;
};

const enqueueIndoorJob = (deviceId, job) => {
  ringingByDeviceId.set(deviceId, job);
  return job.finally(() => {
    ringingByDeviceId.delete(deviceId);
  });
};

const indoorInviteOpts = (cfg, meta = {}) => ({
  host: cfg.host,
  sipPort: cfg.sipPort,
  voipNumber: cfg.voipNumber,
  username: cfg.username || "admin",
  password: cfg.password || "",
  holdMs: meta.holdMs,
  answerMs: meta.answerMs,
  audioPath: meta.audioPath,
  silent: true,
});

/** 依設備主檔振鈴；同設備同時只允許一通 */
async function ringIndoorDevice(device, meta = {}) {
  const cfg = parseDeviceConfig(device);
  const deviceId = assertIndoorDevice(device, cfg);
  return enqueueIndoorJob(deviceId, inviteIndoorRing(indoorInviteOpts(cfg, meta)));
}

/** 依設備主檔：等待接聽 → 播放警報音訊 → BYE */
async function playIndoorDevice(device, meta = {}) {
  const cfg = parseDeviceConfig(device);
  const deviceId = assertIndoorDevice(device, cfg);
  return enqueueIndoorJob(
    deviceId,
    inviteIndoorBroadcast(indoorInviteOpts(cfg, meta)),
  );
}

/**
 * 警報連動：有設定音檔則廣播，否則只振鈴
 */
async function alertIndoorDevice(device, meta = {}) {
  if (isAlertBroadcastConfigured()) {
    try {
      return await playIndoorDevice(device, meta);
    } catch (err) {
      logger.warn("警報語音廣播失敗，改為只振鈴", {
        deviceId: device?.id,
        error: err?.message || String(err),
      });
    }
  }
  return ringIndoorDevice(device, meta);
}

module.exports = {
  inviteIndoorRing,
  inviteIndoorBroadcast,
  alertIndoorDevice,
  isAlertBroadcastConfigured,
  resolveBroadcastAudioPath,
  DEFAULT_HOLD_MS,
  DEFAULT_ANSWER_MS,
};
