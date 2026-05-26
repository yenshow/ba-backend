/**
 * ISAPI subscribeEvent 探測（對齊後端佈防：預設 eventMode=all）
 *
 * 用法：
 *   set ISAPI_PASSWORD=你的密碼
 *   node .\scripts\isapiSubscribeProde.js
 *
 * 環境變數：
 *   ISAPI_HOST, ISAPI_PORT, ISAPI_USERNAME, ISAPI_PASSWORD（必填）
 *   ISAPI_SUBSCRIBE_MODE=all|list  （預設 all，與門禁／車輛 isapiVehicleSubscribeService 相同）
 *   ISAPI_CHANNEL_ID, ISAPI_EVENT_TYPES（僅 list 模式）, ISAPI_HEARTBEAT
 *   ISAPI_MAX_PARTS, ISAPI_EXIT_AFTER_MS
 */

/* eslint-disable no-console */

const { createIsapiClient } = require("../src/services/accessControl/isapiClient");

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");

const SUBSCRIBE_XML_ALL = `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <heartbeat>30</heartbeat>
    <eventMode>all</eventMode>
</SubscribeEvent>`;

const ensureInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const parseCsv = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const buildSubscribeXmlList = ({ channelId, eventTypes, heartbeat }) => {
  const ch = ensureInt(channelId) ?? 1;
  const hb = ensureInt(heartbeat) ?? 10;
  const types =
    Array.isArray(eventTypes) && eventTypes.length > 0
      ? eventTypes
      : ["PeopleCounting"];
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
  const data = err?.response?.data;
  let bodyPreview = null;
  if (Buffer.isBuffer(data)) bodyPreview = toPreviewText(data, 1200);
  else if (typeof data === "string") bodyPreview = toPreviewText(Buffer.from(data), 1200);
  else if (data && typeof data.pipe === "function") {
    try {
      const chunks = [];
      data.on("data", (c) => chunks.push(c));
      data.on("end", () => {
        bodyPreview = toPreviewText(Buffer.concat(chunks), 1200);
      });
    } catch (_e) {}
  }
  return { status, statusText, bodyPreview };
};

const parseContentType = (headerStr) =>
  (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";

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
      if (buffer.length >= sep.length && buffer.slice(0, sep.length).equals(sep)) {
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
    let next = buffer.indexOf(sepWithCRLF, bodyStart);
    if (next === -1) next = buffer.indexOf(sep, bodyStart);
    if (next === -1) return false;
    let bodyEnd = next;
    if (buffer[bodyEnd - 1] === 0x0a && buffer[bodyEnd - 2] === 0x0d) bodyEnd -= 2;
    const body = buffer.slice(bodyStart, bodyEnd);
    buffer = buffer.slice(next);
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
    inputStream.on("close", () => resolve({ parts: partCount, ended: "close" }));
  });
};

async function main() {
  const host = process.env.ISAPI_HOST || "192.168.2.138";
  const port = ensureInt(process.env.ISAPI_PORT) ?? 80;
  const username = process.env.ISAPI_USERNAME || "admin";
  const password = process.env.ISAPI_PASSWORD || "";
  const subscribeMode = String(process.env.ISAPI_SUBSCRIBE_MODE || "all")
    .trim()
    .toLowerCase();
  const channelId = ensureInt(process.env.ISAPI_CHANNEL_ID) ?? 1;
  const eventTypes = parseCsv(process.env.ISAPI_EVENT_TYPES);
  const heartbeat = ensureInt(process.env.ISAPI_HEARTBEAT) ?? 30;
  const maxParts = ensureInt(process.env.ISAPI_MAX_PARTS) ?? 20;
  const exitAfterMs = ensureInt(process.env.ISAPI_EXIT_AFTER_MS) ?? 60_000;

  if (!password) {
    throw new Error("請設定環境變數 ISAPI_PASSWORD（勿將密碼寫入程式碼）。");
  }

  const xmlBody =
    subscribeMode === "list"
      ? buildSubscribeXmlList({ channelId, eventTypes, heartbeat })
      : SUBSCRIBE_XML_ALL;

  const client = createIsapiClient({ host, port, username, password });

  console.log("[ISAPI Probe] subscribeEvent start", {
    host,
    port,
    username,
    subscribeMode,
    channelId: subscribeMode === "list" ? channelId : undefined,
    eventTypes:
      subscribeMode === "list"
        ? eventTypes.length > 0
          ? eventTypes
          : ["PeopleCounting"]
        : "(all)",
    heartbeat: subscribeMode === "list" ? heartbeat : 30,
    maxParts,
    exitAfterMs,
  });
  console.log("[ISAPI Probe] subscribe XML:\n", xmlBody);

  const res = await client.requestSubscribeStream(xmlBody);
  const ct = res.headers?.["content-type"] || "";
  console.log("[ISAPI Probe] connected", { status: res.status, contentType: ct });

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
        const partCt = parseContentType(headerStr);
        const isXml = /xml/i.test(partCt);
        const isJson = /json/i.test(partCt);
        const isImage = /image\//i.test(partCt);

        console.log(`\n[ISAPI Probe] part #${index}`, {
          contentType: partCt || "(unknown)",
          bytes: body.length,
        });
        if (isImage) {
          console.log("[ISAPI Probe] image bytes only");
          return;
        }
        if (isXml || isJson) {
          console.log(toPreviewText(body));
          return;
        }
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
  console.error("[ISAPI Probe] failed", {
    message: err?.message || String(err),
    status: details.status,
    statusText: details.statusText,
    bodyPreview: details.bodyPreview,
  });
  if (details.status === 500 && String(process.env.ISAPI_SUBSCRIBE_MODE || "all") === "list") {
    console.error(
      "[ISAPI Probe] 提示：車牌機請改用 ISAPI_SUBSCRIBE_MODE=all（與後端車輛訂閱相同），list+PeopleCounting 可能回 500。",
    );
  }
  process.exitCode = 1;
});
