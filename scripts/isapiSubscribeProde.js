/**
 * ISAPI subscribeEvent 探測（POST subscribeEvent?deployID=1）
 *
 * Runbook：docs/10-setting/troubleshooting-isapi-events.md
 *
 * 用法：修改 SCRIPT_CONFIG 後執行
 *   node scripts/isapiSubscribeProde.js
 */

/* eslint-disable no-console */

const { createIsapiClient } = require("../src/services/accessControl/isapiClient");

// ── 現場參數 ─────────────────────────────────────────────────────
const SCRIPT_CONFIG = {
  host: "192.168.6.101",
  port: 80,
  username: "admin",
  password: "",
  /** "all"（門禁）| "list"（PeopleCounting 攝影機） */
  subscribeMode: "all",
  channelId: null,
  eventTypes: ["cidEvent"],
  heartbeat: null,
  xmlNs: "http://www.hikvision.com/ver20/XMLSchema",
  maxParts: 20,
  exitAfterMs: 60_000,
  showKeepAlive: false,
};
// ─────────────────────────────────────────────────────────────────

const CRLFCRLF = Buffer.from("\r\n\r\n");

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

const toPreviewText = (buf, maxLen = 800) => {
  const raw = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  const s = raw.replace(/^\uFEFF/, "").trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}\n... (truncated)` : s;
};

const buildSubscribeXmlList = ({
  channelId,
  eventTypes,
  heartbeat,
  xmlns = SCRIPT_CONFIG.xmlNs,
}) => {
  const ch = ensureInt(channelId);
  const includeChannels = ch != null;
  const hb = ensureInt(heartbeat) ?? 6;
  const types = eventTypes?.length ? eventTypes : ["cidEvent"];
  const eventsXml = types
    .map((t) => {
      const channelsLine = includeChannels
        ? `\n            <channels>${ch}</channels>`
        : "";
      return `\n        <Event>\n            <type>${t}</type>${channelsLine}\n        </Event>`;
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

const buildSubscribeXml = () => {
  const mode = String(SCRIPT_CONFIG.subscribeMode || "all")
    .trim()
    .toLowerCase();
  if (mode !== "list") return SUBSCRIBE_XML_ALL;
  return buildSubscribeXmlList({
    channelId: SCRIPT_CONFIG.channelId,
    eventTypes: SCRIPT_CONFIG.eventTypes,
    heartbeat:
      ensureInt(SCRIPT_CONFIG.heartbeat) ??
      (mode === "list" ? 6 : 30),
    xmlns: String(SCRIPT_CONFIG.xmlNs || "").trim() || SCRIPT_CONFIG.xmlNs,
  });
};

const parseContentType = (headerStr) =>
  (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";

const extractPartPayload = (headerStr, body) => {
  let partCt = parseContentType(headerStr);
  let payload = body;

  const embeddedHeadEnd = body.indexOf(CRLFCRLF);
  if (embeddedHeadEnd > 0 && embeddedHeadEnd < 512) {
    const maybeHeaders = body.slice(0, embeddedHeadEnd).toString("latin1");
    if (/content-type:/i.test(maybeHeaders)) {
      partCt = partCt || parseContentType(maybeHeaders);
      payload = body.slice(embeddedHeadEnd + 4);
    }
  }

  const payloadText = payload.toString("utf8").replace(/^\uFEFF/, "").trim();
  return { partCt, payload, payloadText };
};

const isBinaryBuffer = (buf) => {
  if (!buf || buf.length < 2) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50) return true;
  const sample = buf.slice(0, Math.min(buf.length, 256));
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32 || b > 126) nonPrintable += 1;
  }
  return nonPrintable / sample.length > 0.3;
};

const parseJsonPart = (buf) => {
  try {
    const obj = JSON.parse(toPreviewText(buf, 512 * 1024));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
};

const isKeepAliveEvent = (payloadText) => {
  if (!payloadText) return false;

  if (payloadText[0] === "{") {
    const obj = parseJsonPart(Buffer.from(payloadText, "utf8"));
    if (!obj) return false;
    const eventType = String(obj.eventType || "").toLowerCase();
    if (eventType === "heartbeat" || eventType === "heart beat") return true;
    if (String(obj.eventState || "").toLowerCase() === "inactive") return true;
    return !obj.eventType && Boolean(obj.ipAddress || obj.portNo || obj.macAddress);
  }

  if (payloadText[0] === "<") {
    const t = payloadText.toLowerCase();
    return (
      t.includes("<eventtype>heartbeat</eventtype>") ||
      (t.includes("eventstate") && t.includes("inactive"))
    );
  }

  return false;
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
  if (!rawBoundary) return { parts: 0, ended: "no-boundary" };

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
            inputStream.destroy();
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
  const {
    host,
    username,
    password,
    subscribeMode,
    maxParts,
    exitAfterMs,
    showKeepAlive,
  } = SCRIPT_CONFIG;
  const port = ensureInt(SCRIPT_CONFIG.port) ?? 80;

  if (!String(password ?? "").trim()) {
    throw new Error("請於 SCRIPT_CONFIG 填入 password。");
  }

  const xmlBody = buildSubscribeXml();
  const stats = {
    skippedKeepAlive: 0,
    skippedBinary: 0,
    printed: 0,
  };

  console.log("[ISAPI Probe] start", {
    host,
    port,
    subscribeMode,
    filterKeepAlive: !showKeepAlive,
  });
  console.log("[ISAPI Probe] XML:\n", xmlBody);

  const client = createIsapiClient({ host, port, username, password });
  const res = await client.requestSubscribeStream(xmlBody);
  const ct = res.headers["content-type"] || "";

  console.log("[ISAPI Probe] connected", {
    status: res.status,
    contentType: ct,
  });

  const timer = setTimeout(() => res.data.destroy(), exitAfterMs ?? 60_000);

  try {
    const result = await consumeMultipartStream({
      stream: res.data,
      contentType: ct,
      maxParts: ensureInt(maxParts) ?? 20,
      onPart: async ({ index, headerStr, body }) => {
        const { partCt, payload, payloadText } = extractPartPayload(
          headerStr,
          body,
        );

        if (/image\//i.test(partCt) || isBinaryBuffer(payload)) {
          stats.skippedBinary += 1;
          if (showKeepAlive) {
            console.log(`[ISAPI Probe] #${index} binary ${payload.length}B`);
          }
          return;
        }

        if (!showKeepAlive && isKeepAliveEvent(payloadText)) {
          stats.skippedKeepAlive += 1;
          return;
        }

        const looksText =
          /json|xml/i.test(partCt) ||
          payloadText.startsWith("{") ||
          payloadText.startsWith("<");

        if (!looksText && isBinaryBuffer(payload)) {
          stats.skippedBinary += 1;
          return;
        }

        stats.printed += 1;
        console.log(`\n[ISAPI Probe] #${index}`, {
          contentType: partCt || "(unknown)",
          bytes: payload.length,
        });
        if (looksText) console.log(toPreviewText(payload));
      },
    });
    console.log("\n[ISAPI Probe] done", { ...result, ...stats });
  } finally {
    clearTimeout(timer);
  }
};

main().catch((err) => {
  console.error("[ISAPI Probe] failed:", err?.message || String(err));
  if (/HTTP 500/.test(err?.message) && SCRIPT_CONFIG.subscribeMode === "list") {
    console.error(
      "[ISAPI Probe] 提示：list 模式 500 可改 subscribeMode=all；PeopleCounting 用 eventTypes=[\"PeopleCounting\"]、channelId=1。",
    );
  }
  process.exitCode = 1;
});
