/**
 * 門禁 ISAPI 佈防訂閱服務
 * 後端主動向門禁設備 POST subscribeEvent，建立長連線接收事件，寫入 isapi_access_events 並推送 WebSocket。
 */
const path = require("path");
const fs = require("fs");
const db = require("../../database/db");
const accessControlService = require("./accessControlService");
const {
  persistIsapiEvent,
  isProcessableEvent,
  attachPictureToEvent,
} = require("./isapiEventPersistence");
const logger = require("../../utils/logger").createLogger("ISAPI Subscribe");

/** 訂閱全部事件（eventMode=all），寫入時仍僅處理 major=5 且 sub∈{75,76,2077,2078,2079} */
const SUBSCRIBE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <heartbeat>30</heartbeat>
    <eventMode>all</eventMode>
</SubscribeEvent>`;

const RE_CONNECT_DELAY_MS = 10000;
const UPLOADS_ISAPI_DIR = path.join(process.cwd(), "uploads", "isapi-events");

/** 確保 uploads/isapi-events 存在 */
function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_ISAPI_DIR)) {
    fs.mkdirSync(UPLOADS_ISAPI_DIR, { recursive: true });
  }
}

/**
 * 取得需訂閱的門禁設備 ID 列表（people_counting 地點的 entry_device_id、exit_device_id 去重）
 */
async function getDeviceIdsToSubscribe() {
  const rows = await db.query(
    `SELECT DISTINCT (ls.system_config->>'entry_device_id') AS id FROM location_systems ls
     WHERE ls.system_type = 'people_counting'
       AND (ls.system_config->>'entry_device_id') IS NOT NULL AND (ls.system_config->>'entry_device_id') != ''
     UNION
     SELECT DISTINCT (ls.system_config->>'exit_device_id') AS id FROM location_systems ls
     WHERE ls.system_type = 'people_counting'
       AND (ls.system_config->>'exit_device_id') IS NOT NULL AND (ls.system_config->>'exit_device_id') != ''`,
    [],
  );
  const ids = new Set();
  for (const r of rows || []) {
    const n = r.id != null ? parseInt(r.id, 10) : NaN;
    if (Number.isFinite(n)) ids.add(n);
  }
  return Array.from(ids);
}

/**
 * 從 JSON 字串擷取事件欄位（設備以 application/json 推送 heartbeat／事件）
 */
function parseEventJson(jsonStr) {
  if (!jsonStr || typeof jsonStr !== "string") return null;
  let obj;
  try {
    obj = JSON.parse(jsonStr.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const result = {
    eventType: "AccessControllerEvent",
    ipAddress: "",
    dateTime: "",
    AccessControllerEvent: {},
  };
  const alert = obj.eventNotificationAlert || obj.EventNotificationAlert || obj;
  const ac = alert.AccessControllerEvent || alert.accessControllerEvent || alert;
  result.eventType = alert.eventType ?? ac.eventType ?? obj.eventType ?? result.eventType;
  result.ipAddress = alert.ipAddress ?? ac.ipAddress ?? obj.ipAddress ?? "";
  result.dateTime = alert.dateTime ?? ac.dateTime ?? obj.dateTime ?? "";
  const major = ac.majorEventType ?? alert.majorEventType ?? obj.majorEventType;
  const sub = ac.subEventType ?? alert.subEventType ?? obj.subEventType;
  if (major != null) result.AccessControllerEvent.majorEventType = parseInt(major, 10);
  if (sub != null) result.AccessControllerEvent.subEventType = parseInt(sub, 10);
  result.employeeNoString = alert.employeeNoString ?? ac.employeeNoString ?? obj.employeeNoString ?? "";
  result.employeeNo = alert.employeeNo ?? ac.employeeNo ?? obj.employeeNo ?? "";
  result.personName = alert.personName ?? alert.name ?? ac.personName ?? ac.name ?? obj.personName ?? obj.name ?? "";
  if (!result.eventType && (obj.ipAddress || obj.portNo || obj.macAddress)) result.eventType = "heartBeat";
  return result;
}

/**
 * 處理單一事件：寫入 DB（附圖由下一個 part 以「先 JSON 後圖」補上）
 * @returns {Promise<number|null>} 新插入的 isapi_access_events.id，供下一 part 補圖
 */
async function handleEvent(parsed, deviceIp) {
  const ac = parsed.AccessControllerEvent || {};
  const payload = {
    ...ac,
    employeeNoString: parsed.employeeNoString ?? "",
    employeeNo: parsed.employeeNo ?? "",
    personName: parsed.personName ?? "",
  };
  const { id } = await persistIsapiEvent({
    deviceIp: parsed.ipAddress || deviceIp || "",
    eventTime: parsed.dateTime || new Date().toISOString(),
    eventType: parsed.eventType || "AccessControllerEvent",
    payload,
  });
  return id ?? null;
}

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");

/**
 * 長連線 multipart 串流解析（順序：先 JSON 事件、後圖）。依 boundary 切 part、Content-Length 讀 body。
 */
async function consumeEventStreamIncremental(
  stream,
  contentType,
  deviceIp,
  deviceId,
) {
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
  let lastWrittenEventId = null;

  const processParsedEvent = async (parsed) => {
    if (!parsed) return;
    const ac = parsed.AccessControllerEvent || {};
    if (String(parsed.eventType).toLowerCase() === "heartbeat") return;
    if (!isProcessableEvent(ac)) return;
    const id = await handleEvent(parsed, deviceIp);
    if (id) lastWrittenEventId = id;
    logger.info("[ISAPI] 已寫入門禁事件", { deviceId, deviceIp });
  };

  const processPart = (headerStr, body) => {
    const ct = (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";
    const name = (headerStr.match(/Content-Disposition[^;]*name="([^"]+)"/i) || [])[1] || "";
    const rawBody = body.toString("utf8").replace(/^\uFEFF/, "").trim();
    if (/application\/json/i.test(ct) || (rawBody.length > 0 && rawBody[0] === "{")) {
      const parsed = parseEventJson(rawBody);
      if (parsed) processParsedEvent(parsed).catch(() => {});
      return;
    }
    if (/image/i.test(ct) || /\.(jpg|jpeg|png)$/i.test(name) && lastWrittenEventId != null) {
      attachPictureToEvent(lastWrittenEventId, body, UPLOADS_ISAPI_DIR).catch(() => {});
      lastWrittenEventId = null;
    }
  };

  const tryConsumeOnePart = () => {
    // 找 part 起點：\r\n--boundary 或 開頭 --boundary
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
    } else {
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
    processPart(headerStr, body);
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

/**
 * 處理單一設備訂閱：發送訂閱、長連線增量解析事件，連線斷開後拋出以便重連
 */
async function runSubscribeForDevice(deviceId) {
  const { device, client } =
    await accessControlService.getDeviceAndClient(deviceId);
  const deviceIp = device.config?.host || "";

  const res = await client.requestSubscribeStream(SUBSCRIBE_XML);
  const contentType = res.headers["content-type"] || "";
  const stream = res.data;
  await consumeEventStreamIncremental(stream, contentType, deviceIp, deviceId);
}

/**
 * 單一設備訂閱迴圈：連線 → 讀取 → 結束後延遲重連
 */
async function subscribeLoop(deviceId) {
  for (;;) {
    try {
      await runSubscribeForDevice(deviceId);
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, RE_CONNECT_DELAY_MS));
  }
}

let started = false;
/** 目前訂閱中的設備 ID 列表（start 時寫入，供狀態查詢） */
let subscribedDeviceIds = [];

/**
 * 啟動佈防訂閱服務：對所有需訂閱的門禁設備建立訂閱迴圈
 */
async function start() {
  if (started) return;
  ensureUploadsDir();
  const deviceIds = await getDeviceIdsToSubscribe();
  if (deviceIds.length === 0) {
    started = true;
    subscribedDeviceIds = [];
    return;
  }
  logger.info("[ISAPI] 佈防訂閱啟動", { deviceIds: deviceIds.join(","), count: deviceIds.length });
  started = true;
  subscribedDeviceIds = deviceIds;
  for (const deviceId of deviceIds) {
    subscribeLoop(deviceId); // 各設備獨立迴圈，不 await
  }
}

function stop() {
  started = false;
  subscribedDeviceIds = [];
}

/**
 * 取得佈防訂閱狀態（供確認是否已實施佈防）
 * @returns {{ started: boolean, deviceIds: number[] }}
 */
function getSubscribeStatus() {
  return { started, deviceIds: [...subscribedDeviceIds] };
}

module.exports = {
  start,
  stop,
  getSubscribeStatus,
  getDeviceIdsToSubscribe,
  SUBSCRIBE_XML,
};
