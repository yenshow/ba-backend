/**
 * 攝影機 ISAPI PeopleCounting 佈防訂閱服務
 * 後端主動向攝影機 POST subscribeEvent，建立長連線接收 PeopleCounting 事件並寫入 DB，然後推送 WebSocket 觸發前端重拉。
 *
 * 事件來源：/ISAPI/Event/notification/subscribeEvent (multipart stream)
 * 事件格式：XML EventNotificationAlert，包含 peopleCounting.enter/exit（累積值）
 */
const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("./isapiClient");
const websocketService = require("../websocket/websocketService");
const logger = require("../../utils/logger").createLogger(
  "ISAPI Camera PeopleCounting Subscribe",
);

const RE_CONNECT_DELAY_MS = 10000;

const buildSubscribeXml = (channelId = 1) => `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <heartbeat>30</heartbeat>
  <channelMode>list</channelMode>
  <eventMode>list</eventMode>
  <EventList>
    <Event>
      <type>PeopleCounting</type>
      <channels>${Number(channelId) || 1}</channels>
    </Event>
  </EventList>
</SubscribeEvent>`;

function normalizeDeviceHost(host) {
  if (!host || typeof host !== "string") return "";
  const trimmed = host.trim();
  const m = trimmed.match(/^(?:https?:\/\/)?([^:/]+)/);
  return m ? m[1] : trimmed;
}

async function getCameraSubscriptions() {
  const rows = await db.query(
    `SELECT DISTINCT
        (ls.system_config->>'camera_device_id') AS camera_device_id,
        COALESCE(NULLIF(ls.system_config->>'camera_channel_id',''), '1') AS camera_channel_id
     FROM location_systems ls
     WHERE ls.system_type = 'people_counting'
       AND (ls.system_config->>'data_source') = 'camera_isapi'
       AND (ls.system_config->>'camera_device_id') IS NOT NULL
       AND (ls.system_config->>'camera_device_id') != ''`,
    [],
  );

  const subs = [];
  for (const r of rows || []) {
    const deviceId = r.camera_device_id != null ? Number(r.camera_device_id) : NaN;
    const channelId = r.camera_channel_id != null ? Number(r.camera_channel_id) : 1;
    if (!Number.isFinite(deviceId) || deviceId <= 0) continue;
    subs.push({
      deviceId,
      channelId: Number.isFinite(channelId) && channelId > 0 ? channelId : 1,
    });
  }
  return subs;
}

const CRLFCRLF = Buffer.from("\r\n\r\n");

function extractBoundary(contentType) {
  if (!contentType) return null;
  const m = String(contentType).match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (!m) return null;
  return (m[1] || m[2] || "").trim().replace(/^["']|["']$/g, "") || null;
}

function getHeaderValue(headerStr, headerName) {
  const m = String(headerStr).match(
    new RegExp(`${headerName}:\\s*([^\\r\\n]+)`, "i"),
  );
  return (m && m[1] ? String(m[1]) : "").trim();
}

function extractText(xml, tag) {
  if (!xml) return null;
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = String(xml).match(re);
  return m && m[1] != null ? String(m[1]).trim() : null;
}

function parsePeopleCountingEventXml(xmlText) {
  const xml = String(xmlText || "").replace(/^\uFEFF/, "").trim();
  if (!xml) return null;

  const eventType = extractText(xml, "eventType");
  if (eventType !== "PeopleCounting") return null;

  const eventTime = extractText(xml, "dateTime") || extractText(xml, "time");
  const channelIdRaw = extractText(xml, "channelID");
  const channelId = channelIdRaw != null ? Number(channelIdRaw) : 1;

  const enterRaw = extractText(xml, "enter");
  const exitRaw = extractText(xml, "exit");
  const enterTotal = enterRaw != null && enterRaw !== "" ? Number(enterRaw) : null;
  const exitTotal = exitRaw != null && exitRaw !== "" ? Number(exitRaw) : null;

  // RegionList 可能很大，先保留原始片段（若不存在則為 null）
  const regionListXml = (() => {
    const m = xml.match(/<RegionList>[\s\S]*?<\/RegionList>/i);
    return m ? m[0] : null;
  })();

  return {
    channelId: Number.isFinite(channelId) && channelId > 0 ? channelId : 1,
    eventTime: eventTime || new Date().toISOString(),
    enterTotal: Number.isFinite(enterTotal) ? enterTotal : null,
    exitTotal: Number.isFinite(exitTotal) ? exitTotal : null,
    regionListXml,
    rawXml: xml,
  };
}

async function persistPeopleCountingEvent({
  deviceIp,
  channelId,
  eventTime,
  enterTotal,
  exitTotal,
  regionListXml,
  rawXml,
}) {
  const regionList = regionListXml != null ? { xml: regionListXml } : null;

  const rows = await db.query(
    `INSERT INTO isapi_people_counting_events
      (device_ip, channel_id, event_time, enter_total, exit_total, region_list, raw_xml)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      String(deviceIp || ""),
      Number(channelId) || 1,
      new Date(eventTime).toISOString(),
      enterTotal,
      exitTotal,
      // jsonb 欄位直接傳 object，避免文字型別無法自動 cast
      regionList,
      rawXml || "",
    ],
  );
  return rows?.[0]?.id ?? null;
}

async function consumeSubscribeStream(stream, contentType, deviceIp, expectedChannelId) {
  const boundary = extractBoundary(contentType);
  if (!boundary) {
    return new Promise((resolve, reject) => {
      stream.on("data", () => {});
      stream.on("error", reject);
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
    });
  }

  const sep = Buffer.from(`--${boundary}`, "utf8");
  const sepWithCRLF = Buffer.from(`\r\n--${boundary}`, "utf8");
  let buffer = Buffer.alloc(0);

  const processPart = async (headerStr, body) => {
    const ct = getHeaderValue(headerStr, "Content-Type");
    const bodyText = body.toString("utf8").replace(/^\uFEFF/, "");

    const isXmlLike =
      /xml/i.test(ct) || bodyText.trimStart().startsWith("<");
    if (!isXmlLike) return;

    const parsed = parsePeopleCountingEventXml(bodyText);
    if (!parsed) return;

    const channelId = parsed.channelId || expectedChannelId || 1;
    try {
      const id = await persistPeopleCountingEvent({
        deviceIp,
        channelId,
        eventTime: parsed.eventTime,
        enterTotal: parsed.enterTotal,
        exitTotal: parsed.exitTotal,
        regionListXml: parsed.regionListXml,
        rawXml: parsed.rawXml,
      });

      if (id) {
        logger.info("[ISAPI Camera] 已寫入 PeopleCounting 事件", {
          id,
          deviceIp,
          channelId,
          eventTime: parsed.eventTime,
          enterTotal: parsed.enterTotal,
          exitTotal: parsed.exitTotal,
        });
        websocketService.emitIsapiPeopleCountingCameraEvent({
          deviceIp,
          channelId,
        });
      }
    } catch (err) {
      logger.warn("[ISAPI Camera] 寫入 PeopleCounting 事件失敗", {
        deviceIp,
        channelId,
        error: err && err.message ? err.message : String(err),
      });
    }
  };

  const tryConsumeOnePart = () => {
    let start = buffer.indexOf(sepWithCRLF);
    let skip = sepWithCRLF.length;
    if (start === -1) {
      if (buffer.length >= sep.length && buffer.slice(0, sep.length).equals(sep)) {
        start = 0;
        skip = sep.length;
      } else {
        return false;
      }
    } else if (start > 0) {
      buffer = buffer.slice(start);
      start = 0;
      skip = sepWithCRLF.length;
    }

    const afterBoundary = buffer.slice(skip);
    const headEnd = afterBoundary.indexOf(CRLFCRLF);
    if (headEnd === -1) return false;
    const headerStr = afterBoundary.slice(0, headEnd).toString("utf8");
    const bodyStart = skip + headEnd + CRLFCRLF.length;

    const contentLengthRaw = getHeaderValue(headerStr, "Content-Length");
    const contentLength =
      contentLengthRaw && /^\d+$/.test(contentLengthRaw)
        ? Number.parseInt(contentLengthRaw, 10)
        : null;

    let bodyEnd;
    if (contentLength != null) {
      bodyEnd = bodyStart + contentLength;
      if (bodyEnd > buffer.length) return false;
    } else {
      const next1 = buffer.indexOf(sepWithCRLF, bodyStart);
      const next2 = buffer.indexOf(sep, bodyStart);
      if (next1 === -1 && next2 === -1) return false;
      if (next1 === -1) bodyEnd = next2;
      else if (next2 === -1) bodyEnd = next1;
      else bodyEnd = Math.min(next1, next2);

      if (bodyEnd < bodyStart) return false;
      if (buffer[bodyEnd - 1] === 0x0a && buffer[bodyEnd - 2] === 0x0d) bodyEnd -= 2;
    }

    const body = buffer.slice(bodyStart, bodyEnd);
    buffer = buffer.slice(bodyEnd);
    processPart(headerStr, body).catch(() => {});
    return true;
  };

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0 && tryConsumeOnePart()) {}
      if (buffer.length > 1024 * 1024) buffer = buffer.slice(-512 * 1024);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
  });
}

async function runSubscribeForCamera(deviceId, channelId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  const cfg = device?.config || {};
  if (!cfg.host || !cfg.username || !cfg.password) {
    const err = new Error("設備連線設定不完整（缺少 host / username / password）");
    err.statusCode = 400;
    throw err;
  }
  const client = createIsapiClient(cfg);

  const host = cfg.host || "";
  const deviceIp = normalizeDeviceHost(host);
  if (!deviceIp) {
    const err = new Error("攝影機設備缺少有效 host");
    err.statusCode = 400;
    throw err;
  }

  const xml = buildSubscribeXml(channelId);
  const res = await client.requestSubscribeStream(xml);
  const contentType = res.headers["content-type"] || "";
  const stream = res.data;

  await consumeSubscribeStream(stream, contentType, deviceIp, channelId);
}

async function subscribeLoop(deviceId, channelId) {
  for (;;) {
    try {
      await runSubscribeForCamera(deviceId, channelId);
    } catch (err) {
      logger.warn("[ISAPI Camera] 訂閱連線中斷/失敗，準備重連", {
        deviceId,
        channelId,
        error: err && err.message ? err.message : String(err),
      });
    }
    await new Promise((r) => setTimeout(r, RE_CONNECT_DELAY_MS));
  }
}

let started = false;
let subscribed = [];

async function start() {
  if (started) return;
  const subs = await getCameraSubscriptions();
  if (subs.length === 0) {
    started = true;
    subscribed = [];
    return;
  }

  // 同一 (deviceId, channelId) 去重
  const uniq = new Map();
  for (const s of subs) {
    uniq.set(`${s.deviceId}:${s.channelId}`, s);
  }
  subscribed = [...uniq.values()];

  logger.info("[ISAPI Camera] PeopleCounting 佈防訂閱啟動", {
    count: subscribed.length,
    targets: subscribed.map((s) => `${s.deviceId}:${s.channelId}`).join(","),
  });

  started = true;
  for (const s of subscribed) {
    // 各設備/通道獨立迴圈，不 await
    subscribeLoop(s.deviceId, s.channelId);
  }
}

function stop() {
  started = false;
  subscribed = [];
}

function getSubscribeStatus() {
  return {
    started,
    targets: subscribed.map((s) => ({ ...s })),
  };
}

module.exports = {
  start,
  stop,
  getSubscribeStatus,
  buildSubscribeXml,
};

