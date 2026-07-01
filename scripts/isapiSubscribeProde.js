/**
 * ISAPI subscribeEvent 探測（獨立版，POST /ISAPI/Event/notification/subscribeEvent）
 *
 * 現場排查 Runbook：docs/10-setting/troubleshooting-isapi-events.md
 *
 * 用法（於 ba-backend 目錄，先修改下方 SCRIPT_CONFIG）：
 *   node scripts/isapiSubscribeProde.js
 *
 * list 模式範例（PeopleCounting 攝影機）：
 *   subscribeMode: "list"
 *   eventTypes: ["PeopleCounting"]
 *   channelId: 1
 */

/* eslint-disable no-console */

const net = require("net");
const crypto = require("crypto");
const { PassThrough } = require("stream");

// ── 現場參數（直接修改此區）──────────────────────────────────────
const SCRIPT_CONFIG = {
  host: "192.168.6.101",
  port: 80,
  username: "admin",
  password: "",
  /** "all" | "list"（門禁機多用 all；PeopleCounting 攝影機用 list） */
  subscribeMode: "all",
  /** list 模式選填；有值時 Event 會帶 channels 與 channelMode=list */
  channelId: null,
  /** list 模式事件類型 */
  eventTypes: ["cidEvent"],
  /** list 預設 6、all 預設 30；設 null 使用預設 */
  heartbeat: null,
  xmlNs: "http://www.hikvision.com/ver20/XMLSchema",
  maxParts: 20,
  exitAfterMs: 60_000,
  /** false（預設）過濾心跳／圖片二進位；true 時全部顯示 */
  showKeepAlive: false,
  requestTimeoutMs: 10_000,
};
// ─────────────────────────────────────────────────────────────────

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");

const toPreviewText = (buf, maxLen = 800) => {
  const raw = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  const s = raw.replace(/^\uFEFF/, "").trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}\n... (truncated)` : s;
};

const SUBSCRIBE_XML_ALL = `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <heartbeat>30</heartbeat>
    <eventMode>all</eventMode>
</SubscribeEvent>`;

const ensureInt = (v) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const parseCsv = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const DEFAULT_HIKVISION_XML_NS = "http://www.hikvision.com/ver20/XMLSchema";

const buildSubscribeXmlList = ({
  channelId,
  eventTypes,
  heartbeat,
  xmlns = DEFAULT_HIKVISION_XML_NS,
}) => {
  const ch = ensureInt(channelId);
  const includeChannels = ch != null;
  const hb = ensureInt(heartbeat) ?? 6;
  const types =
    Array.isArray(eventTypes) && eventTypes.length > 0
      ? eventTypes
      : ["cidEvent"];
  const eventsXml = types
    .map((t) => {
      const channelsLine = includeChannels
        ? `\n            <channels>${ch}</channels>`
        : "";
      return `
        <Event>
            <type>${t}</type>${channelsLine}
        </Event>`;
    })
    .join("");

  const channelModeLine = includeChannels
    ? "\n    <channelMode>list</channelMode>"
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="${xmlns}">${channelModeLine}
    <heartbeat>${hb}</heartbeat>
    <eventMode>list</eventMode>
    <EventList>${eventsXml}
    </EventList>
</SubscribeEvent>`;
};

const parseDigestChallenge = (header) => {
  const params = {};
  const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
  let m;
  while ((m = regex.exec(header)) !== null) {
    params[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return params;
};

const buildDigestResponse = ({
  username,
  password,
  method,
  uri,
  realm,
  nonce,
  qop,
  nc,
  cnonce,
  opaque,
  algorithm,
}) => {
  const md5 = (str) => crypto.createHash("md5").update(str).digest("hex");
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
  ];
  if (opaque) parts.push(`opaque="${opaque}"`);
  if (algorithm) parts.push(`algorithm=${algorithm}`);
  return `Digest ${parts.join(", ")}`;
};

const buildAuthHeader = (challenge, method, uri, username, password) => {
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  return buildDigestResponse({
    username,
    password,
    method: method.toUpperCase(),
    uri,
    realm: challenge.realm || "",
    nonce: challenge.nonce || "",
    qop: challenge.qop || "auth",
    nc,
    cnonce,
    opaque: challenge.opaque,
    algorithm: challenge.algorithm,
  });
};

const readStreamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

const parseHttpHeaders = (headerBlock) => {
  const lines = headerBlock.split(/\r\n/);
  const statusMatch = (lines[0] || "").match(/^HTTP\/\d(?:\.\d)? (\d{3})/i);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const headers = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${val}` : val;
  }
  return { status, headers };
};

/**
 * 以 raw TCP 送 HTTP，手動解析標頭（繞過 Node HTTP parser，避免 Invalid header token）。
 */
const rawHttpRequest = ({ host, port, method, path, headers = {}, body }) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timeout = setTimeout(() => {
      socket.destroy();
      finish(() =>
        reject(new Error(`請求逾時（${SCRIPT_CONFIG.requestTimeoutMs}ms）`)),
      );
    }, SCRIPT_CONFIG.requestTimeoutMs);

    socket.on("connect", () => {
      const headerLines = [
        `${method.toUpperCase()} ${path} HTTP/1.1`,
        `Host: ${host}`,
        "Connection: close",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ];
      socket.write(headerLines.join("\r\n"));
      if (body != null) socket.write(body);
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headEnd = buffer.indexOf(CRLFCRLF);
      if (headEnd === -1) return;

      clearTimeout(timeout);
      const headerBlock = buffer.slice(0, headEnd).toString("latin1");
      const bodyStart = headEnd + 4;
      const parsed = parseHttpHeaders(headerBlock);
      const stream = new PassThrough();
      const remainder = buffer.slice(bodyStart);
      if (remainder.length) stream.write(remainder);

      socket.removeAllListeners("data");
      socket.on("data", (c) => stream.write(c));
      socket.on("end", () => stream.end());
      socket.on("error", (e) => stream.destroy(e));

      finish(() =>
        resolve({
          status: parsed.status,
          headers: parsed.headers,
          body: stream,
        }),
      );
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      finish(() => reject(err));
    });
  });

const rawHttpSubscribePost = ({
  host,
  port,
  path,
  headers = {},
  body,
}) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timeout = setTimeout(() => {
      socket.destroy();
      finish(() =>
        reject(new Error(`等待訂閱回應標頭逾時（${SCRIPT_CONFIG.requestTimeoutMs}ms）`)),
      );
    }, SCRIPT_CONFIG.requestTimeoutMs);

    socket.on("connect", () => {
      const headerLines = [
        `POST ${path} HTTP/1.1`,
        `Host: ${host}`,
        "Connection: keep-alive",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ];
      socket.write(headerLines.join("\r\n"));
      socket.write(body);
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headEnd = buffer.indexOf(CRLFCRLF);
      if (headEnd === -1) return;

      clearTimeout(timeout);
      const headerBlock = buffer.slice(0, headEnd).toString("latin1");
      const bodyStart = headEnd + 4;
      const parsed = parseHttpHeaders(headerBlock);
      const stream = new PassThrough();
      const remainder = buffer.slice(bodyStart);
      if (remainder.length) stream.write(remainder);

      socket.removeAllListeners("data");
      socket.on("data", (c) => stream.write(c));
      socket.on("end", () => stream.end());
      socket.on("error", (e) => stream.destroy(e));

      finish(() =>
        resolve({
          status: parsed.status,
          headers: parsed.headers,
          data: stream,
        }),
      );
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      finish(() => reject(err));
    });
  });

const fetchDigestChallenge = async ({ host, port }) => {
  const res = await rawHttpRequest({
    host,
    port,
    method: "GET",
    path: "/ISAPI/System/deviceInfo",
  });
  await readStreamToBuffer(res.body);

  if (res.status !== 401 || !res.headers["www-authenticate"]) {
    throw new Error(
      `預期設備回傳 401 Digest 挑戰，實際 HTTP ${res.status || "(unknown)"}`,
    );
  }

  const authHeader = res.headers["www-authenticate"];
  if (!String(authHeader).toLowerCase().startsWith("digest ")) {
    throw new Error(`不支援的認證方式: ${String(authHeader).split(" ")[0]}`);
  }

  return parseDigestChallenge(authHeader);
};

const requestSubscribeStream = async ({ host, port, username, password, xmlBody }) => {
  const path = "/ISAPI/Event/notification/subscribeEvent";
  const challenge = await fetchDigestChallenge({ host, port });
  const digestAuth = buildAuthHeader(
    challenge,
    "POST",
    path,
    username,
    password,
  );

  const res = await rawHttpSubscribePost({
    host,
    port,
    path,
    headers: {
      "Content-Type": "application/xml",
      Authorization: digestAuth,
      "Content-Length": String(Buffer.byteLength(xmlBody)),
    },
    body: xmlBody,
  });

  if (res.status >= 400) {
    const buf = await readStreamToBuffer(res.data);
    const preview = toPreviewText(buf, 1200);
    throw new Error(
      `訂閱失敗 HTTP ${res.status}${preview ? `\n${preview}` : ""}`,
    );
  }

  return {
    status: res.status,
    headers: { "content-type": res.headers["content-type"] || "" },
    data: res.data,
  };
};

const parseJsonPart = (buf) => {
  const raw = toPreviewText(buf, 512 * 1024);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
};

const isBinaryBuffer = (buf) => {
  if (!buf || buf.length < 2) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return true;
  }
  const sample = buf.slice(0, Math.min(buf.length, 256));
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32 || b > 126) nonPrintable += 1;
  }
  return nonPrintable / sample.length > 0.3;
};

const parseContentType = (headerStr) =>
  (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";

/**
 * 部分設備 part 內嵌 Content-Type／Content-Length 後才是 JSON（見現場 YS-AC）。
 */
const extractPartPayload = (headerStr, body) => {
  let partCt = parseContentType(headerStr);
  let payload = body;

  const embeddedHeadEnd = body.indexOf(CRLFCRLF);
  if (embeddedHeadEnd > 0 && embeddedHeadEnd < 512) {
    const maybeHeaders = body.slice(0, embeddedHeadEnd).toString("latin1");
    if (/content-type:/i.test(maybeHeaders)) {
      const embeddedCt = parseContentType(maybeHeaders);
      if (embeddedCt) partCt = partCt || embeddedCt;
      payload = body.slice(embeddedHeadEnd + 4);
    }
  }

  const payloadText = payload.toString("utf8").replace(/^\uFEFF/, "").trim();
  return { partCt, payload, payloadText };
};

const isKeepAliveEvent = (obj) => {
  if (!obj || typeof obj !== "object") return false;
  const eventType = String(obj.eventType || "").toLowerCase();
  if (eventType === "heartbeat" || eventType === "heart beat") return true;

  const eventState = String(obj.eventState || "").toLowerCase();
  if (eventState === "inactive") return true;

  if (!obj.eventType && (obj.ipAddress || obj.portNo || obj.macAddress))
    return true;

  return false;
};

const isKeepAliveXml = (text) => {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.includes("<eventtype>heartbeat</eventtype>")) return true;
  if (t.includes("<eventtype>heart beat</eventtype>")) return true;
  if (t.includes("eventstate") && t.includes("inactive")) return true;
  return false;
};

const isKeepAliveJsonText = (text) => {
  if (!text || text[0] !== "{") return false;
  const parsed = parseJsonPart(Buffer.from(text, "utf8"));
  return Boolean(parsed && isKeepAliveEvent(parsed));
};

const consumeMultipartStream = async ({
  stream: inputStream,
  contentType,
  maxParts,
  onPart,
}) => {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  const rawBoundary = boundaryMatch
    ? (boundaryMatch[1] || boundaryMatch[2]).trim()
    : null;
  if (!rawBoundary) {
    return { parts: 0, ended: "no-boundary" };
  }

  const boundary = rawBoundary.replace(/^["']|["']$/g, "");
  const sep = Buffer.from(`--${boundary}`, "utf8");
  const sepWithCRLF = Buffer.from(`\r\n--${boundary}`, "utf8");
  let buffer = Buffer.alloc(0);
  let partCount = 0;

  const tryConsumeOnePart = async () => {
    if (buffer.length === 0) return false;
    let start = buffer.indexOf(sepWithCRLF);
    let skip = sepWithCRLF.length;
    if (start === -1) {
      if (
        buffer.length >= sep.length &&
        buffer.slice(0, sep.length).equals(sep)
      ) {
        start = 0;
        skip = sep.length;
      } else return false;
    } else if (start > 0) {
      buffer = buffer.slice(start);
      skip = sepWithCRLF.length;
    }
    const afterBoundary = buffer.slice(skip);
    const headEnd = afterBoundary.indexOf(CRLFCRLF);
    if (headEnd === -1) return false;
    const headerStr = afterBoundary.slice(0, headEnd).toString("utf8");
    const bodyStart = skip + headEnd + CRLFCRLF.length;
    const contentLengthMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
    const contentLength = contentLengthMatch
      ? parseInt(contentLengthMatch[1], 10)
      : 0;
    let bodyEnd;
    if (contentLength > 0) {
      bodyEnd = bodyStart + contentLength;
      if (bodyEnd > buffer.length) return false;
    } else {
      let next = buffer.indexOf(sepWithCRLF, bodyStart);
      if (next === -1) next = buffer.indexOf(sep, bodyStart);
      if (next === -1) return false;
      bodyEnd = next;
      if (buffer[bodyEnd - 1] === 0x0a && buffer[bodyEnd - 2] === 0x0d)
        bodyEnd -= 2;
    }
    const body = buffer.slice(bodyStart, bodyEnd);
    buffer = buffer.slice(bodyEnd);
    partCount += 1;
    await onPart({ index: partCount, headerStr, body });
    return true;
  };

  return new Promise((resolve, reject) => {
    inputStream.on("data", async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (buffer.length > 0 && (await tryConsumeOnePart())) {
          if (partCount >= maxParts) {
            try {
              inputStream.destroy();
            } catch (_e) {}
            resolve({ parts: partCount, ended: "maxParts" });
            return;
          }
        }
        if (buffer.length > 1024 * 1024) buffer = buffer.slice(-512 * 1024);
      } catch (e) {
        reject(e);
      }
    });
    inputStream.on("error", reject);
    inputStream.on("end", () => resolve({ parts: partCount, ended: "end" }));
    inputStream.on("close", () =>
      resolve({ parts: partCount, ended: "close" }),
    );
  });
};

const main = async () => {
  const host = SCRIPT_CONFIG.host;
  const port = ensureInt(SCRIPT_CONFIG.port) ?? 80;
  const username = SCRIPT_CONFIG.username;
  const password = SCRIPT_CONFIG.password;
  const subscribeMode = String(SCRIPT_CONFIG.subscribeMode || "all")
    .trim()
    .toLowerCase();
  const channelId = ensureInt(SCRIPT_CONFIG.channelId);
  const eventTypes = Array.isArray(SCRIPT_CONFIG.eventTypes)
    ? SCRIPT_CONFIG.eventTypes.filter(Boolean)
    : parseCsv(SCRIPT_CONFIG.eventTypes);
  const heartbeat =
    ensureInt(SCRIPT_CONFIG.heartbeat) ??
    (subscribeMode === "list" ? 6 : 30);
  const xmlNs =
    String(SCRIPT_CONFIG.xmlNs || "").trim() || DEFAULT_HIKVISION_XML_NS;
  const maxParts = ensureInt(SCRIPT_CONFIG.maxParts) ?? 20;
  const exitAfterMs = ensureInt(SCRIPT_CONFIG.exitAfterMs) ?? 60_000;
  const showKeepAlive = Boolean(SCRIPT_CONFIG.showKeepAlive);
  const partStats = { skippedKeepAlive: 0, skippedBinary: 0, printed: 0 };

  if (!String(password ?? "").trim()) {
    throw new Error("請於腳本 SCRIPT_CONFIG 填入 password。");
  }

  const xmlBody =
    subscribeMode === "list"
      ? buildSubscribeXmlList({
          channelId,
          eventTypes,
          heartbeat,
          xmlns: xmlNs,
        })
      : SUBSCRIBE_XML_ALL;

  const listEventTypes = eventTypes.length > 0 ? eventTypes : ["cidEvent"];

  console.log("[ISAPI Probe] subscribeEvent start", {
    url: `http://${host}:${port}/ISAPI/Event/notification/subscribeEvent`,
    host,
    port,
    username,
    subscribeMode,
    channelId: subscribeMode === "list" ? (channelId ?? "(none)") : undefined,
    eventTypes: subscribeMode === "list" ? listEventTypes : "(all)",
    heartbeat: subscribeMode === "list" ? heartbeat : 30,
    xmlNs: subscribeMode === "list" ? xmlNs : undefined,
    maxParts,
    exitAfterMs,
    filterKeepAlive: !showKeepAlive,
  });
  console.log("[ISAPI Probe] subscribe XML:\n", xmlBody);

  console.log("[ISAPI Probe] fetching digest challenge…");
  const res = await requestSubscribeStream({
    host,
    port,
    username,
    password,
    xmlBody,
  });
  const ct = res.headers?.["content-type"] || "";
  console.log("[ISAPI Probe] connected", {
    status: res.status,
    contentType: ct,
  });

  const inputStream = res.data;
  const timer = setTimeout(() => {
    try {
      inputStream.destroy();
    } catch (_e) {}
  }, exitAfterMs);

  try {
    const result = await consumeMultipartStream({
      stream: inputStream,
      contentType: ct,
      maxParts,
      onPart: async ({ index, headerStr, body }) => {
        const { partCt, payload, payloadText } = extractPartPayload(
          headerStr,
          body,
        );
        const isImage =
          /image\//i.test(partCt) || isBinaryBuffer(payload);

        if (isImage) {
          partStats.skippedBinary += 1;
          if (showKeepAlive) {
            console.log(`\n[ISAPI Probe] part #${index} (binary)`, {
              contentType: partCt || "application/octet-stream",
              bytes: payload.length,
            });
          }
          return;
        }

        const looksJson =
          /json/i.test(partCt) || payloadText.startsWith("{");
        const looksXml =
          /xml/i.test(partCt) || payloadText.startsWith("<");

        if (!showKeepAlive) {
          if (looksJson) {
            const parsed = parseJsonPart(payload);
            if (
              (parsed && isKeepAliveEvent(parsed)) ||
              isKeepAliveJsonText(payloadText)
            ) {
              partStats.skippedKeepAlive += 1;
              return;
            }
          }
          if (looksXml && isKeepAliveXml(payloadText)) {
            partStats.skippedKeepAlive += 1;
            return;
          }
        }

        partStats.printed += 1;
        console.log(`\n[ISAPI Probe] part #${index}`, {
          contentType: partCt || "(unknown)",
          bytes: payload.length,
        });
        if (looksJson || looksXml) {
          console.log(toPreviewText(payload));
          return;
        }
        if (!isBinaryBuffer(payload)) {
          const preview = toPreviewText(payload);
          if (preview) console.log(preview);
        }
      },
    });
    console.log("\n[ISAPI Probe] done", { ...result, ...partStats });
  } finally {
    clearTimeout(timer);
  }
};

main().catch((err) => {
  const message = err?.message || String(err);
  console.error("[ISAPI Probe] failed", { message });
  if (/invalid header token/i.test(message)) {
    console.error(
      "[ISAPI Probe] 提示：若仍出現 Invalid header token，請確認 host/port 是否為門禁／攝影機 ISAPI 埠（非 Web 管理介面其他埠）。",
    );
  }
  if (
    /HTTP 500/.test(message) &&
    String(SCRIPT_CONFIG.subscribeMode || "list").toLowerCase() === "list"
  ) {
    console.error(
      "[ISAPI Probe] 提示：若 cidEvent list 仍回 500，可試 subscribeMode=all；人數統計請設 eventTypes=[\"PeopleCounting\"] 與 channelId=1。",
    );
  }
  process.exitCode = 1;
});
