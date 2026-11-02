/**
 * ISAPI subscribeEvent 探測（POST subscribeEvent?deployID=1）
 *
 * Runbook：docs/10-setting/faq-troubleshooting.md
 *
 * 用法（測人臉時請先停掉後端佈防，避免搶連線）：
 *   node scripts/probe/isapiSubscribeProbe.js
 *   npm run probe:isapi
 *
 * 現場參數優先用環境變數覆寫 SCRIPT_CONFIG（見 runbook §2.3）。
 *
 * fullDump=true：業務事件印完整 JSON／XML（預設省略 modelData base64）
 * omitModelData=false：連 modelData 也印出（輸出會很長）
 */

/* eslint-disable no-console */

const {
  createIsapiClient,
} = require("../../src/services/accessControl/isapiClient");

// ── 現場參數 ─────────────────────────────────────────────────────
const SCRIPT_CONFIG = {
  host: "192.168.2.210",
  port: 80,
  username: "admin",
  password: "Aa83124007",
  /** "all"（門禁／讀卡機）| "list"（PeopleCounting／人臉攝影機） */
  subscribeMode: "all",
  channelId: 1,
  eventTypes: ["faceCapture", "AccessControllerEvent"],
  heartbeat: null,
  xmlNs: "http://www.isapi.org/ver20/XMLSchema",
  maxParts: 40,
  exitAfterMs: 120_000,
  /** 探測預設印 heartbeat，避免誤以為沒收到 */
  showKeepAlive: true,
  /** 業務事件印完整內容（不截斷）；modelData base64 預設省略以便對欄位 */
  fullDump: true,
  omitModelData: true,
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

const envText = (name) => {
  const raw = process.env[name];
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed === "" ? null : trimmed;
};

const applyEnvOverrides = (defaults) => {
  const next = { ...defaults };
  const host = envText("ISAPI_HOST");
  const username = envText("ISAPI_USERNAME");
  const password = envText("ISAPI_PASSWORD");
  const subscribeMode = envText("ISAPI_SUBSCRIBE_MODE");
  const eventTypes = envText("ISAPI_EVENT_TYPES");
  const port = ensureInt(process.env.ISAPI_PORT);
  const channelId = ensureInt(process.env.ISAPI_CHANNEL_ID);
  const exitAfterMs = ensureInt(process.env.ISAPI_EXIT_AFTER_MS);

  if (host) next.host = host;
  if (port != null) next.port = port;
  if (username) next.username = username;
  if (password) next.password = password;
  if (subscribeMode) next.subscribeMode = subscribeMode;
  if (channelId != null) next.channelId = channelId;
  if (eventTypes) {
    next.eventTypes = eventTypes
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (exitAfterMs != null) next.exitAfterMs = exitAfterMs;
  if (envText("ISAPI_PROBE_SHOW_KEEPALIVE") === "1") {
    next.showKeepAlive = true;
  }
  return next;
};

const CONFIG = applyEnvOverrides(SCRIPT_CONFIG);

const toPreviewText = (buf, maxLen = 800) => {
  const raw = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  const s = raw.replace(/^\uFEFF/, "").trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}\n... (truncated)` : s;
};

/** 省略 modelData base64，其餘欄位完整保留 */
const omitModelDataDeep = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(omitModelDataDeep);
  const out = {};
  for (const [key, val] of Object.entries(node)) {
    if (/^modeldata$/i.test(key) && typeof val === "string") {
      out[key] = `[base64 omitted, ${val.length} chars]`;
    } else if (val && typeof val === "object") {
      out[key] = omitModelDataDeep(val);
    } else {
      out[key] = val;
    }
  }
  return out;
};

/** 業務事件完整輸出（JSON pretty；XML 全文） */
const formatEventDump = (payloadText, { omitModelData = true } = {}) => {
  const text = String(payloadText || "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return "(empty)";
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      let obj = JSON.parse(text);
      if (omitModelData) obj = omitModelDataDeep(obj);
      return JSON.stringify(obj, null, 2);
    } catch {
      return text;
    }
  }
  return text;
};

const buildSubscribeXmlList = ({
  channelId,
  eventTypes,
  heartbeat,
  xmlns = CONFIG.xmlNs,
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
  const mode = String(CONFIG.subscribeMode || "all")
    .trim()
    .toLowerCase();
  if (mode !== "list") return SUBSCRIBE_XML_ALL;
  return buildSubscribeXmlList({
    channelId: CONFIG.channelId,
    eventTypes: CONFIG.eventTypes,
    heartbeat: ensureInt(CONFIG.heartbeat) ?? (mode === "list" ? 6 : 30),
    xmlns: String(CONFIG.xmlNs || "").trim() || CONFIG.xmlNs,
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

  const payloadText = payload
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trim();
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

const keepAliveLabel = (payloadText) => {
  if (!payloadText) return null;

  if (payloadText[0] === "{") {
    const obj = parseJsonPart(Buffer.from(payloadText, "utf8"));
    if (!obj) return null;
    const eventType = String(obj.eventType || "").toLowerCase();
    if (eventType === "heartbeat" || eventType === "heart beat") {
      return eventType;
    }
    if (
      String(obj.eventState || "").toLowerCase() === "inactive" &&
      eventType &&
      eventType !== "accesscontrollerevent"
    ) {
      return `${eventType}/inactive`;
    }
    return null;
  }

  if (payloadText[0] === "<") {
    const t = payloadText.toLowerCase();
    if (t.includes("<eventtype>heartbeat</eventtype>")) return "heartbeat";
    if (
      t.includes("eventstate") &&
      t.includes("inactive") &&
      !t.includes("accesscontrollerevent")
    ) {
      return "xml-inactive";
    }
  }

  return null;
};

const previewBody = (data, maxLen = 800) => {
  if (data == null) return "";
  if (Buffer.isBuffer(data)) return toPreviewText(data, maxLen);
  if (typeof data === "string") return toPreviewText(data, maxLen);
  try {
    return toPreviewText(JSON.stringify(data, null, 2), maxLen);
  } catch {
    return String(data);
  }
};

const dumpGet = async (client, path) => {
  try {
    const res = await client.request({ method: "GET", path });
    console.log(
      `[ISAPI Probe] GET ${path} HTTP ${res.status}\n${previewBody(res.data, 1200)}`,
    );
  } catch (error) {
    console.log(
      `[ISAPI Probe] GET ${path} failed: ${error?.message || String(error)}`,
    );
  }
};

const dumpRecentAcsEvents = async (client) => {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  try {
    const res = await client.request({
      method: "POST",
      path: "/ISAPI/AccessControl/AcsEvent?format=json",
      data: {
        AcsEventCond: {
          searchID: `probe-${Date.now()}`,
          searchResultPosition: 0,
          maxResults: 5,
          major: 5,
          minor: 0,
          startTime: `${date}T00:00:00+08:00`,
          endTime: `${date}T23:59:59+08:00`,
        },
      },
    });
    const acs = res.data?.AcsEvent || res.data?.acsEvent || res.data || {};
    const infoList = acs.InfoList || acs.infoList || [];
    const rows = (Array.isArray(infoList) ? infoList : [infoList])
      .filter(Boolean)
      .slice(-5)
      .map((item) => ({
        time: item.time || item.dateTime || "",
        employee: item.employeeNoString || item.employeeNo || "",
        name: item.name || item.personName || "",
        major: item.major ?? item.majorEventType,
        minor: item.minor ?? item.subEventType,
        cardNo: item.cardNo || "",
      }));
    console.log("[ISAPI Probe] AcsEvent 今日最近筆", rows);
  } catch (error) {
    console.log(
      `[ISAPI Probe] AcsEvent 查詢失敗: ${error?.message || String(error)}`,
    );
  }
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

  const tryConsumeOnePart = () => {
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
    Promise.resolve(onPart({ index: partCount, headerStr, body })).catch(
      (error) => {
        throw error;
      },
    );
    return true;
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ended) => {
      if (settled) return;
      settled = true;
      resolve({ parts: partCount, ended });
    };
    inputStream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (buffer.length > 0 && tryConsumeOnePart()) {
          if (partCount >= maxParts) {
            inputStream.destroy();
            finish("maxParts");
            return;
          }
        }
        if (buffer.length > 1024 * 1024) buffer = buffer.slice(-512 * 1024);
      } catch (e) {
        reject(e);
      }
    });
    inputStream.on("error", reject);
    inputStream.on("end", () => finish("end"));
    inputStream.on("close", () => finish("close"));
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
    fullDump,
    omitModelData,
  } = CONFIG;
  const port = ensureInt(CONFIG.port) ?? 80;

  if (!String(password ?? "").trim()) {
    throw new Error("請於 SCRIPT_CONFIG 或 ISAPI_PASSWORD 填入 password。");
  }

  const xmlBody = buildSubscribeXml();
  const stats = {
    skippedKeepAlive: 0,
    skippedBinary: 0,
    printed: 0,
    recvBytes: 0,
    recvChunks: 0,
  };

  console.log("[ISAPI Probe] start", {
    host,
    port,
    subscribeMode,
    filterKeepAlive: !showKeepAlive,
    fullDump: fullDump !== false,
    omitModelData: omitModelData !== false,
    exitAfterMs: exitAfterMs ?? 120_000,
  });
  console.log("[ISAPI Probe] XML:\n", xmlBody);

  const client = createIsapiClient({ host, port, username, password });
  await dumpGet(client, "/ISAPI/System/deviceInfo");
  await dumpGet(client, "/ISAPI/Event/notification/httpHosts");
  await dumpRecentAcsEvents(client);

  const res = await client.requestSubscribeStream(xmlBody);
  const ct = res.headers["content-type"] || "";

  console.log("[ISAPI Probe] connected", {
    status: res.status,
    contentType: ct,
    headers: res.headers,
  });
  console.log(
    "[ISAPI Probe] 訂閱已建立（僅即時事件）。請保持運行，看到 recv 後再刷卡；heartbeat 會印一行。勿立刻 Ctrl+C。",
  );

  const waitMs = exitAfterMs ?? 120_000;
  const timer = setTimeout(() => res.data.destroy(), waitMs);
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    console.log("[ISAPI Probe] waiting", {
      elapsedSec,
      recvBytes: stats.recvBytes,
      recvChunks: stats.recvChunks,
      parts: stats.printed + stats.skippedKeepAlive + stats.skippedBinary,
    });
  }, 10_000);

  res.data.on("data", (chunk) => {
    stats.recvBytes += chunk.length;
    stats.recvChunks += 1;
    console.log(
      `[ISAPI Probe] recv ${chunk.length}B total=${stats.recvBytes}`,
    );
  });

  try {
    const result = await consumeMultipartStream({
      stream: res.data,
      contentType: ct,
      maxParts: ensureInt(maxParts) ?? 40,
      onPart: async ({ index, headerStr, body }) => {
        const { partCt, payload, payloadText } = extractPartPayload(
          headerStr,
          body,
        );

        if (/image\//i.test(partCt) || isBinaryBuffer(payload)) {
          stats.skippedBinary += 1;
          console.log(`[ISAPI Probe] #${index} binary ${payload.length}B`);
          return;
        }

        const keepAlive = keepAliveLabel(payloadText);
        if (keepAlive) {
          stats.skippedKeepAlive += 1;
          console.log(
            `[ISAPI Probe] #${index} keepalive (${keepAlive}) ${payload.length}B`,
          );
          if (showKeepAlive) {
            console.log(toPreviewText(payloadText, 400));
          }
          return;
        }

        const looksText =
          /json|xml/i.test(partCt) ||
          payloadText.startsWith("{") ||
          payloadText.startsWith("<");

        if (!looksText && isBinaryBuffer(payload)) {
          stats.skippedBinary += 1;
          console.log(`[ISAPI Probe] #${index} binary ${payload.length}B`);
          return;
        }

        stats.printed += 1;
        console.log(`\n[ISAPI Probe] #${index}`, {
          contentType: partCt || "(unknown)",
          bytes: payload.length,
        });
        if (looksText) {
          if (fullDump === false) {
            console.log(toPreviewText(payloadText, 800));
          } else {
            console.log(
              formatEventDump(payloadText, {
                omitModelData: omitModelData !== false,
              }),
            );
          }
        }
      },
    });
    console.log("\n[ISAPI Probe] done", { ...result, ...stats });
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
  }
};

main().catch((err) => {
  console.error("[ISAPI Probe] failed:", err?.message || String(err));
  if (/HTTP 500/.test(err?.message) && CONFIG.subscribeMode === "list") {
    console.error(
      '[ISAPI Probe] 提示：list 模式 500 可改 subscribeMode=all；PeopleCounting 用 eventTypes=["PeopleCounting"]、channelId=1。',
    );
  }
  process.exitCode = 1;
});
