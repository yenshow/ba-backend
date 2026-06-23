/**
 * ISAPI subscribeEvent 探測（POST /ISAPI/Event/notification/subscribeEvent）
 *
 * 現場排查 Runbook：docs/10-setting/troubleshooting-isapi-events.md
 *
 * 用法：
 *   set ISAPI_PASSWORD=你的密碼
 *   node .\scripts\isapiSubscribeProde.js
 *
 * 預設訂閱（list + cidEvent，Hikvision xmlns）：
 *   POST http://192.168.2.95:80/ISAPI/Event/notification/subscribeEvent
 *   heartbeat=6, eventMode=list, type=cidEvent（無 channels）
 *
 * 環境變數：
 *   ISAPI_HOST, ISAPI_PORT, ISAPI_USERNAME, ISAPI_PASSWORD（必填）
 *   ISAPI_SUBSCRIBE_MODE=all|list  （預設 list）
 *   ISAPI_EVENT_TYPES（list，預設 cidEvent）, ISAPI_HEARTBEAT（list，預設 6）
 *   ISAPI_CHANNEL_ID（選填；有值時 Event 會帶 channels 與 channelMode=list）
 *   ISAPI_XML_NS（list，預設 http://www.hikvision.com/ver20/XMLSchema）
 *   ISAPI_MAX_PARTS, ISAPI_EXIT_AFTER_MS
 *   ISAPI_PROBE_SHOW_KEEPALIVE=1  （預設過濾 heartbeat／eventState=inactive 等維持連線推送）
 */

/* eslint-disable no-console */

const {
  createIsapiClient,
} = require("../src/services/accessControl/isapiClient");

const CRLF = Buffer.from("\r\n");
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

const toPreviewText = (buf, maxLen = 800) => {
  const raw = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  const s = raw.replace(/^\uFEFF/, "").trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}\n... (truncated)` : s;
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

/**
 * 是否為訂閱維持連線用的推送（非實際告警／業務事件）。
 * 對齊 isapiSubscribeService：略過 eventType=heartBeat／heartbeat；
 * 此設備訂閱 cidEvent 時常以 eventState=inactive 週期推送（間隔接近 XML heartbeat）。
 */
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

const extractAxiosErrorDetails = (err) => {
  const status = err?.response?.status;
  const statusText = err?.response?.statusText;
  const data = err?.response?.data;
  let bodyPreview = null;
  if (Buffer.isBuffer(data)) bodyPreview = toPreviewText(data, 1200);
  else if (typeof data === "string")
    bodyPreview = toPreviewText(Buffer.from(data), 1200);
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
    let next = buffer.indexOf(sepWithCRLF, bodyStart);
    if (next === -1) next = buffer.indexOf(sep, bodyStart);
    if (next === -1) return false;
    let bodyEnd = next;
    if (buffer[bodyEnd - 1] === 0x0a && buffer[bodyEnd - 2] === 0x0d)
      bodyEnd -= 2;
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
    inputStream.on("close", () =>
      resolve({ parts: partCount, ended: "close" }),
    );
  });
};

async function main() {
  const host = process.env.ISAPI_HOST || "192.168.6.101";
  const port = ensureInt(process.env.ISAPI_PORT) ?? 80;
  const username = process.env.ISAPI_USERNAME || "admin";
  const password = process.env.ISAPI_PASSWORD || "Aa83124007";
  const subscribeMode = String(process.env.ISAPI_SUBSCRIBE_MODE || "all")
    .trim()
    .toLowerCase();
  const channelIdRaw = process.env.ISAPI_CHANNEL_ID;
  const channelId =
    channelIdRaw !== undefined && String(channelIdRaw).trim() !== ""
      ? ensureInt(channelIdRaw)
      : null;
  const eventTypes = parseCsv(process.env.ISAPI_EVENT_TYPES);
  const heartbeat =
    ensureInt(process.env.ISAPI_HEARTBEAT) ??
    (subscribeMode === "list" ? 6 : 30);
  const xmlNs = process.env.ISAPI_XML_NS?.trim() || DEFAULT_HIKVISION_XML_NS;
  const maxParts = ensureInt(process.env.ISAPI_MAX_PARTS) ?? 20;
  const exitAfterMs = ensureInt(process.env.ISAPI_EXIT_AFTER_MS) ?? 60_000;
  const showKeepAlive = process.env.ISAPI_PROBE_SHOW_KEEPALIVE === "1";
  const partStats = { skippedKeepAlive: 0, printed: 0 };

  if (!password) {
    throw new Error("請設定環境變數 ISAPI_PASSWORD（勿將密碼寫入程式碼）。");
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

  const client = createIsapiClient({ host, port, username, password });
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

  const res = await client.requestSubscribeStream(xmlBody);
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
        const partCt = parseContentType(headerStr);
        const isXml = /xml/i.test(partCt);
        const isJson = /json/i.test(partCt);
        const isImage = /image\//i.test(partCt);

        if (isImage) {
          partStats.printed += 1;
          console.log(`\n[ISAPI Probe] part #${index}`, {
            contentType: partCt || "(unknown)",
            bytes: body.length,
          });
          console.log("[ISAPI Probe] image bytes only");
          return;
        }

        if (isJson && !showKeepAlive) {
          const parsed = parseJsonPart(body);
          if (parsed && isKeepAliveEvent(parsed)) {
            partStats.skippedKeepAlive += 1;
            return;
          }
        }

        partStats.printed += 1;
        console.log(`\n[ISAPI Probe] part #${index}`, {
          contentType: partCt || "(unknown)",
          bytes: body.length,
        });
        if (isXml || isJson) {
          console.log(toPreviewText(body));
          return;
        }
        const preview = toPreviewText(body);
        if (preview) console.log(preview);
      },
    });
    console.log("\n[ISAPI Probe] done", { ...result, ...partStats });
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
  if (
    details.status === 500 &&
    String(process.env.ISAPI_SUBSCRIBE_MODE || "list") === "list"
  ) {
    console.error(
      "[ISAPI Probe] 提示：若 cidEvent list 仍回 500，可試 ISAPI_SUBSCRIBE_MODE=all；人數統計請設 ISAPI_EVENT_TYPES=PeopleCounting 與 ISAPI_CHANNEL_ID=1。",
    );
  }
  process.exitCode = 1;
});
