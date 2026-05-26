/**
 * ISAPI subscribeEvent Probe（用於實機測試事件串流）
 *
 * 用法（PowerShell）：
 *  - node .\scripts\isapiSubscribeProde.js
 *
 * 可用環境變數覆蓋（預設為寫死值，方便直接測）：
 *  - ISAPI_HOST=192.168.2.138
 *  - ISAPI_PORT=80
 *  - ISAPI_USERNAME=admin
 *  - ISAPI_PASSWORD=your_password
 *  - ISAPI_CHANNEL_ID=1
 *  - ISAPI_EVENT_TYPES=PeopleCounting,ANPR  （逗號分隔；留空則只訂閱 PeopleCounting）
 *  - ISAPI_HEARTBEAT=10
 *  - ISAPI_MAX_PARTS=20
 *  - ISAPI_EXIT_AFTER_MS=60000
 */

/* eslint-disable no-console */

const { createIsapiClient } = require("../src/services/accessControl/isapiClient");
const util = require("util");
const stream = require("stream");

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");

// 依需求可「寫死帳密」直接測試（請勿提交真實密碼到公開 repo）
const DEFAULT_PASSWORD = "Aa83124007";

const ensureInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const parseCsv = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const buildSubscribeXml = ({ channelId, eventTypes, heartbeat }) => {
  const ch = ensureInt(channelId) ?? 1;
  const hb = ensureInt(heartbeat) ?? 10;
  const types = Array.isArray(eventTypes) && eventTypes.length > 0 ? eventTypes : ["PeopleCounting"];
  const eventsXml = types
    .map(
      (t) => `
    <Event>
      <type>${t}</type>
      <channels>${ch}</channels>
    </Event>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <heartbeat>${hb}</heartbeat>
  <channelMode>list</channelMode>
  <eventMode>list</eventMode>
  <EventList>${eventsXml}
  </EventList>
</SubscribeEvent>`;
};

const toPreviewText = (buf, maxLen = 800) => {
  const raw = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  const s = raw.replace(/^\uFEFF/, "").trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}\n... (truncated)` : s;
};

const extractAxiosErrorDetails = (err) => {
  const status = err?.response?.status;
  const statusText = err?.response?.statusText;
  const headers = err?.response?.headers;
  const data = err?.response?.data;

  const tryExtractBufferedBody = (maybeStream) => {
    if (!maybeStream) return null;
    const bufList = maybeStream?._readableState?.buffer;
    if (!Array.isArray(bufList) || bufList.length === 0) return null;

    // Node 的 internal buffer 可能是 Buffer 或 { data: Buffer }
    const first = bufList[0];
    if (Buffer.isBuffer(first)) return first;
    if (Buffer.isBuffer(first?.data)) return first.data;
    return null;
  };

  let bodyPreview = "";
  if (data != null) {
    if (Buffer.isBuffer(data)) bodyPreview = toPreviewText(data);
    else if (typeof data === "string") bodyPreview = toPreviewText(data);
    else {
      try {
        // 若是 http.IncomingMessage/Readable，優先從 buffer 抽出內容（通常就是 XML 錯誤回應）
        const buffered = tryExtractBufferedBody(data);
        if (buffered) bodyPreview = toPreviewText(buffered);
        else if (data instanceof stream.Readable) bodyPreview = "(response stream; no buffered body)";
        else bodyPreview = toPreviewText(JSON.stringify(data));
      } catch (_e) {
        const buffered = tryExtractBufferedBody(data);
        if (buffered) bodyPreview = toPreviewText(buffered);
        else bodyPreview = util.inspect(data, { depth: 2, maxArrayLength: 20 });
      }
    }
  }

  return { status, statusText, headers, bodyPreview };
};

const parseContentType = (headerStr) => {
  const m = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
  return (m?.[1] || "").trim();
};

const consumeMultipartStream = async ({ stream, contentType, maxParts, onPart }) => {
  const boundaryMatch = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  const rawBoundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : null;
  if (!rawBoundary) {
    throw new Error(`無法從 content-type 解析 boundary：${String(contentType || "")}`);
  }

  const boundary = rawBoundary.replace(/^["']|["']$/g, "");
  const sep = Buffer.from(`--${boundary}`, "utf8");
  const sepWithCRLF = Buffer.from(`\r\n--${boundary}`, "utf8");
  let buffer = Buffer.alloc(0);
  let partCount = 0;

  const tryConsumeOnePart = () => {
    if (maxParts != null && partCount >= maxParts) return false;
    if (buffer.length === 0) return false;

    let start = buffer.indexOf(sep);
    if (start === -1) return false;

    const afterStart = start + sep.length;
    if (buffer.length < afterStart + 2) return false;
    if (buffer[afterStart] === 0x2d && buffer[afterStart + 1] === 0x2d) {
      return false;
    }

    // 跳過起始 boundary + CRLF
    let pos = afterStart;
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;

    const headerEnd = buffer.indexOf(CRLFCRLF, pos);
    if (headerEnd === -1) return false;
    const headerStr = buffer.slice(pos, headerEnd).toString("utf8");

    const bodyStart = headerEnd + CRLFCRLF.length;
    let next = buffer.indexOf(sepWithCRLF, bodyStart);
    if (next === -1) {
      next = buffer.indexOf(sep, bodyStart);
    }
    if (next === -1) return false;

    let bodyEnd = next;
    if (buffer[bodyEnd - 1] === 0x0a && buffer[bodyEnd - 2] === 0x0d) {
      bodyEnd -= 2;
    }
    const body = buffer.slice(bodyStart, bodyEnd);

    partCount += 1;
    onPart?.({ index: partCount, headerStr, body }).catch?.(() => {});

    buffer = buffer.slice(next);
    return true;
  };

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (tryConsumeOnePart()) {}
      if (buffer.length > 1024 * 1024) buffer = buffer.slice(-512 * 1024);
      if (maxParts != null && partCount >= maxParts) {
        try {
          stream.destroy();
        } catch (_e) {}
        resolve({ parts: partCount, ended: "maxParts" });
      }
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ parts: partCount, ended: "end" }));
    stream.on("close", () => resolve({ parts: partCount, ended: "close" }));
  });
};

async function main() {
  const host = process.env.ISAPI_HOST || "192.168.2.138";
  const port = ensureInt(process.env.ISAPI_PORT) ?? 80;
  const username = process.env.ISAPI_USERNAME || "admin";
  const password = process.env.ISAPI_PASSWORD || DEFAULT_PASSWORD;
  const channelId = ensureInt(process.env.ISAPI_CHANNEL_ID) ?? 1;
  const eventTypes = parseCsv(process.env.ISAPI_EVENT_TYPES);
  const heartbeat = ensureInt(process.env.ISAPI_HEARTBEAT) ?? 10;
  const maxParts = ensureInt(process.env.ISAPI_MAX_PARTS) ?? 20;
  const exitAfterMs = ensureInt(process.env.ISAPI_EXIT_AFTER_MS) ?? 60_000;

  if (!password) throw new Error("缺少 ISAPI_PASSWORD（或 DEFAULT_PASSWORD 為空）。");

  const client = createIsapiClient({ host, port, username, password });
  const xmlBody = buildSubscribeXml({ channelId, eventTypes, heartbeat });

  console.log("[ISAPI Probe] subscribeEvent start", {
    host,
    port,
    username,
    channelId,
    eventTypes: eventTypes.length > 0 ? eventTypes : ["PeopleCounting"],
    heartbeat,
    maxParts,
    exitAfterMs,
  });
  console.log("[ISAPI Probe] subscribe XML:");
  console.log(xmlBody);

  const res = await client.requestSubscribeStream(xmlBody);
  const ct = res.headers?.["content-type"] || "";
  console.log("[ISAPI Probe] connected", { status: res.status, contentType: ct });

  const stream = res.data;
  const timer = setTimeout(() => {
    try {
      stream.destroy();
    } catch (_e) {}
  }, exitAfterMs);

  try {
    const result = await consumeMultipartStream({
      stream,
      contentType: ct,
      maxParts,
      onPart: async ({ index, headerStr, body }) => {
        const partCt = parseContentType(headerStr);
        const isXml = /xml/i.test(partCt);
        const isJson = /json/i.test(partCt);
        const isImage = /image\//i.test(partCt);

        console.log(`\n[ISAPI Probe] part #${index}`, { contentType: partCt || "(unknown)", bytes: body.length });
        if (isImage) {
          console.log("[ISAPI Probe] image bytes only");
          return;
        }
        if (isXml || isJson) {
          console.log(toPreviewText(body));
          return;
        }
        // fallback：嘗試當文字印出
        const preview = toPreviewText(body);
        if (preview) console.log(preview);
      },
    });
    console.log("\n[ISAPI Probe] done", result);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  const details = extractAxiosErrorDetails(err);
  if (details.status) {
    console.error("[ISAPI Probe] failed", {
      message: err?.message || String(err),
      status: details.status,
      statusText: details.statusText,
      bodyPreview: details.bodyPreview,
    });
  } else {
    console.error("[ISAPI Probe] failed", err?.message || err);
  }
  process.exitCode = 1;
});
