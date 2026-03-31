/**
 * ISAPI 攝影機 PeopleCounting 訂閱服務
 * - 後端主動 POST /ISAPI/Event/notification/subscribeEvent 建立長連線
 * - 解析 XML EventNotificationAlert（PeopleCounting）
 * - 寫入 isapi_people_counting_events 並推送 WS（前端採防抖重拉）
 *
 * 精簡：僅落地 `statisticalMethods=realTime`（`timeRange` 靜默略過）。
 * 僅落地分區列（RegionList/Region.enter/exit → region_id IS NOT NULL）。
 */
const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const logger = require("../../utils/logger").createLogger(
  "ISAPI PeopleCounting Subscribe",
);
const {
  parsePeopleCountingEventXml,
} = require("./isapiPeopleCountingXmlParser");
const {
  persistPeopleCountingEvent,
} = require("./isapiPeopleCountingPersistence");

const RE_CONNECT_DELAY_MS = 10000;

function ensureInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function buildSubscribeXml(channelId) {
  const ch = ensureInt(channelId) ?? 1;
  return `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <heartbeat>30</heartbeat>
  <channelMode>list</channelMode>
  <eventMode>list</eventMode>
  <EventList>
    <Event>
      <type>PeopleCounting</type>
      <channels>${ch}</channels>
    </Event>
  </EventList>
</SubscribeEvent>`;
}

/**
 * 取得需訂閱的攝影機設定（people_counting 地點、data_source=isapi_camera）
 * @returns {Promise<Array<{ locationId:number, deviceId:number, channelId:number }>>}
 */
async function getCameraSubscriptions() {
  const rows = await db.query(
    `SELECT
       ls.location_id AS location_id,
       (ls.system_config->>'camera_device_id') AS device_id,
       (ls.system_config->'camera_device_ids') AS device_ids,
       (ls.system_config->>'camera_channel_id') AS channel_id
     FROM location_systems ls
     WHERE ls.system_type = 'people_counting'
       AND (ls.system_config->>'data_source') = 'isapi_camera'
       AND (
         (ls.system_config->>'camera_device_id') IS NOT NULL
         OR (ls.system_config->'camera_device_ids') IS NOT NULL
       )`,
    [],
  );
  const subs = [];
  for (const r of rows || []) {
    const locationId = ensureInt(r.location_id);
    const channelId = ensureInt(r.channel_id) ?? 1;
    if (!locationId) continue;

    const deviceIdsFromArray = Array.isArray(r.device_ids)
      ? r.device_ids.map(ensureInt).filter(Boolean)
      : [];
    const deviceIdFallback = ensureInt(r.device_id);
    const deviceIds =
      deviceIdsFromArray.length > 0
        ? deviceIdsFromArray
        : deviceIdFallback
          ? [deviceIdFallback]
          : [];

    for (const deviceId of deviceIds) {
      if (deviceId) subs.push({ locationId, deviceId, channelId });
    }
  }
  // 去重：同一地點/設備/頻道只訂閱一次
  const uniq = new Map();
  for (const s of subs) {
    uniq.set(`${s.locationId}:${s.deviceId}:${s.channelId}`, s);
  }
  return [...uniq.values()];
}

async function getDeviceClient(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  if (
    !device?.config?.host ||
    !device?.config?.username ||
    !device?.config?.password
  ) {
    const err = new Error(
      "攝影機連線設定不完整（缺少 host / username / password）",
    );
    err.statusCode = 400;
    throw err;
  }
  const client = createIsapiClient(device.config);
  return { device, client };
}

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");

async function consumeEventStreamIncremental(stream, contentType, context) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  const rawBoundary = boundaryMatch
    ? (boundaryMatch[1] || boundaryMatch[2]).trim()
    : null;
  if (!rawBoundary) {
    return new Promise((resolve, reject) => {
      stream.on("data", () => {});
      stream.on("error", reject);
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
    });
  }

  const boundary = rawBoundary.replace(/^["']|["']$/g, "");
  const sep = Buffer.from(`--${boundary}`, "utf8");
  const sepWithCRLF = Buffer.from(`\r\n--${boundary}`, "utf8");
  let buffer = Buffer.alloc(0);

  const processPart = async (headerStr, body) => {
    const ct = (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";
    const raw = body
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trim();
    if (!/xml/i.test(ct) && raw.length === 0) return;

    const parsed = parsePeopleCountingEventXml(raw);
    if (!parsed || !parsed.eventTime) return;

    const methodNorm = String(parsed.statisticalMethods ?? "")
      .trim()
      .toLowerCase();
    // 設備會另送 timeRange（區間累計／增量），與即時累計語意不同；僅落地 realTime
    if (methodNorm === "timerange") {
      return;
    }

    const base = {
      locationId: context.locationId,
      deviceId: context.deviceId,
      deviceIp: parsed.deviceIp || context.deviceIp || "",
      channelId: parsed.channelId ?? context.channelId ?? 1,
      eventTime: parsed.eventTime,
      isRetransmission: parsed.isRetransmission ?? false,
    };

    const regions = parsed.regions || [];

    // 區域層級使用 RegionList/Region/* 的 enter/exit
    for (const r of regions) {
      await persistPeopleCountingEvent({
        ...base,
        regionId: r.id ?? null,
        regionName: r.name || null,
        enter: r.enter ?? 0,
        exit: r.exit ?? 0,
      });
    }
  };

  const tryConsumeOnePart = () => {
    let start = buffer.indexOf(sepWithCRLF);
    let skip = sepWithCRLF.length;
    if (start === -1) {
      if (
        buffer.length >= sep.length &&
        buffer.slice(0, sep.length).equals(sep)
      ) {
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
    const contentLengthMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
    const contentLength = contentLengthMatch
      ? parseInt(contentLengthMatch[1], 10)
      : 0;
    let bodyEnd;
    if (contentLength > 0) {
      bodyEnd = bodyStart + contentLength;
      if (bodyEnd > buffer.length) return false;
    } else {
      const nextB = buffer.indexOf(sepWithCRLF, bodyStart);
      const nextB2 = buffer.indexOf(sep, bodyStart);
      const next =
        nextB !== -1
          ? nextB2 !== -1
            ? Math.min(nextB, nextB2)
            : nextB
          : nextB2;
      if (next === -1) return false;
      bodyEnd = next;
      const trim =
        buffer[bodyEnd - 1] === 0x0a && buffer[bodyEnd - 2] === 0x0d ? 2 : 0;
      if (trim) bodyEnd -= trim;
    }
    const body = buffer.slice(bodyStart, bodyEnd);
    processPart(headerStr, body).catch(() => {});
    buffer = buffer.slice(bodyEnd);
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

async function runSubscribeForCamera(sub) {
  const { device, client } = await getDeviceClient(sub.deviceId);
  const deviceIp = device?.config?.host || "";
  const res = await client.requestSubscribeStream(
    buildSubscribeXml(sub.channelId),
  );
  const contentType = res.headers["content-type"] || "";
  const stream = res.data;
  await consumeEventStreamIncremental(stream, contentType, {
    locationId: sub.locationId,
    deviceId: sub.deviceId,
    deviceIp,
    channelId: sub.channelId,
  });
}

async function subscribeLoop(sub) {
  for (;;) {
    try {
      await runSubscribeForCamera(sub);
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, RE_CONNECT_DELAY_MS));
  }
}

let started = false;
let runningSubs = [];

async function start() {
  if (started) return;
  const subs = await getCameraSubscriptions();
  started = true;
  runningSubs = subs;
  if (subs.length === 0) {
    logger.info(
      "[ISAPI PeopleCounting] 無需訂閱（尚未配置 isapi_camera 地點）",
    );
    return;
  }
  logger.info("[ISAPI PeopleCounting] 訂閱啟動", { count: subs.length });
  for (const sub of subs) {
    subscribeLoop(sub);
  }
}

function stop() {
  started = false;
  runningSubs = [];
}

function getSubscribeStatus() {
  return { started, subs: [...runningSubs] };
}

module.exports = {
  start,
  stop,
  getSubscribeStatus,
  getCameraSubscriptions,
};
