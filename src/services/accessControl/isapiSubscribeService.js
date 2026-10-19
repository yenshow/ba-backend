/**
 * 門禁 ISAPI 佈防訂閱服務
 * 後端主動向門禁設備 POST subscribeEvent，建立長連線接收事件，寫入 isapi_access_events 並推送 WebSocket。
 * 落地：./isapiAccessEventPersistence；長連線骨架：../isapi/isapiSubscribeLoop
 */
const db = require("../../database/db");
const accessControlService = require("./accessControlService");
const isapiTimeSyncService = require("../isapi/isapiTimeSyncService");
const {
  createSubscribeManager,
  consumeMultipartEventStream,
} = require("../isapi/isapiSubscribeLoop");
const logger = require("../../utils/logger").createLogger("ISAPI Subscribe");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");
const {
  shouldQueueAccessEventPicture,
} = require("../peopleCounting/accessControlLogLabels");
const {
  scheduleAccessEventBackfill,
} = require("./isapiAccessEventBackfillService");
const {
  isProcessableEvent,
  persistIsapiEvent,
  attachPictureToEvent,
} = require("./isapiAccessEventPersistence");

/** 訂閱全部事件（eventMode=all），寫入時仍僅處理 major=5 且 sub 為門禁驗證／酒精事件 */
const SUBSCRIBE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <heartbeat>30</heartbeat>
    <eventMode>all</eventMode>
</SubscribeEvent>`;

/** 訂閱長連線仍在讀取的設備（與 deviceIds 不同：迴圈在跑不代表 socket 還在） */
const connectedDeviceIds = new Set();

/**
 * 取得需訂閱的門禁設備 ID 列表（people_counting 地點的 entry_device_ids、exit_device_ids 去重）
 */
async function getDeviceIdsToSubscribe() {
  const rows = await db.query(
    `
      SELECT DISTINCT (jsonb_array_elements_text(ls.system_config->'entry_device_ids'))::int AS id
      FROM location_systems ls
      WHERE ls.system_type = 'people_counting'
        AND COALESCE(jsonb_array_length(ls.system_config->'entry_device_ids'), 0) > 0

      UNION

      SELECT DISTINCT (jsonb_array_elements_text(ls.system_config->'exit_device_ids'))::int AS id
      FROM location_systems ls
      WHERE ls.system_type = 'people_counting'
        AND COALESCE(jsonb_array_length(ls.system_config->'exit_device_ids'), 0) > 0

      UNION

      SELECT DISTINCT (jsonb_array_elements_text(ls.system_config->'device_ids'))::int AS id
      FROM location_systems ls
      WHERE ls.system_type = 'roll_call'
        AND COALESCE(jsonb_array_length(ls.system_config->'device_ids'), 0) > 0
    `,
    [],
  );
  const ids = new Set();
  for (const r of rows || []) {
    const n = r.id != null ? parseInt(String(r.id), 10) : NaN;
    if (Number.isFinite(n)) ids.add(n);
  }
  const {
    filterEnabledDeviceIds,
  } = require("../devices/deviceEnabledFilter");
  return filterEnabledDeviceIds(Array.from(ids));
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
  const ac =
    alert.AccessControllerEvent || alert.accessControllerEvent || alert;
  result.eventType =
    alert.eventType ?? ac.eventType ?? obj.eventType ?? result.eventType;
  result.ipAddress = alert.ipAddress ?? ac.ipAddress ?? obj.ipAddress ?? "";
  result.dateTime = alert.dateTime ?? ac.dateTime ?? obj.dateTime ?? "";
  const major = ac.majorEventType ?? alert.majorEventType ?? obj.majorEventType;
  const sub = ac.subEventType ?? alert.subEventType ?? obj.subEventType;
  if (major != null)
    result.AccessControllerEvent.majorEventType = parseInt(major, 10);
  if (sub != null)
    result.AccessControllerEvent.subEventType = parseInt(sub, 10);
  result.employeeNoString =
    alert.employeeNoString ?? ac.employeeNoString ?? obj.employeeNoString ?? "";
  result.employeeNo = alert.employeeNo ?? ac.employeeNo ?? obj.employeeNo ?? "";
  result.personName =
    alert.personName ??
    alert.name ??
    ac.personName ??
    ac.name ??
    obj.personName ??
    obj.name ??
    "";
  if (!result.eventType && (obj.ipAddress || obj.portNo || obj.macAddress))
    result.eventType = "heartBeat";
  return result;
}

/**
 * 處理單一事件：寫入 DB（附圖由下一個 part 以「先 JSON 後圖」補上）
 * @returns {Promise<number|null>} 新插入的 isapi_access_events.id，供下一 part 補圖
 */
async function handleEvent(parsed, deviceIp, deviceId = null) {
  const ac = parsed.AccessControllerEvent || {};
  const payload = {
    ...ac,
    employeeNoString: parsed.employeeNoString ?? "",
    employeeNo: parsed.employeeNo ?? "",
    personName: parsed.personName ?? "",
  };
  const { id } = await persistIsapiEvent({
    deviceId,
    deviceIp: parsed.ipAddress || deviceIp || "",
    eventTime: parsed.dateTime || new Date().toISOString(),
    eventType: parsed.eventType || "AccessControllerEvent",
    payload,
  });
  return id ?? null;
}

/**
 * 長連線 multipart 串流解析（順序：先 JSON 事件、後圖）。依 boundary 切 part、Content-Length 讀 body。
 */
async function consumeEventStreamIncremental(
  stream,
  contentType,
  deviceIp,
  deviceId,
  abortSignal,
) {
  /** 僅人臉事件佔槽；指紋等 JSON 不清除。新人臉覆蓋並 warn。 */
  let lastPendingFaceEventId = null;

  const processParsedEvent = async (parsed) => {
    if (!parsed) return;
    const ac = parsed.AccessControllerEvent || {};
    if (String(parsed.eventType).toLowerCase() === "heartbeat") return;
    if (!isProcessableEvent(ac)) return;
    const id = await handleEvent(parsed, deviceIp, deviceId);
    if (id && shouldQueueAccessEventPicture(ac)) {
      if (lastPendingFaceEventId != null) {
        logger.warn("[ISAPI] 前一人臉事件未收到附圖", {
          deviceId,
          deviceIp,
          eventId: lastPendingFaceEventId,
        });
      }
      lastPendingFaceEventId = id;
    }
    if (id != null) {
      scheduleAccessEventBackfill({
        deviceId,
        deviceIp: parsed.ipAddress || deviceIp || "",
        eventTime: parsed.dateTime || new Date().toISOString(),
      });
    }
    logger.debug("[ISAPI] 已寫入門禁事件", { deviceId, deviceIp });
  };

  await consumeMultipartEventStream({
    stream,
    contentType,
    abortSignal,
    preferContentLength: true,
    onPart: async (headerStr, body) => {
      const ct =
        (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";
      const name =
        (headerStr.match(/Content-Disposition[^;]*name="([^"]+)"/i) ||
          [])[1] || "";
      const rawBody = body
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trim();
      if (
        /application\/json/i.test(ct) ||
        (rawBody.length > 0 && rawBody[0] === "{")
      ) {
        const parsed = parseEventJson(rawBody);
        if (parsed) await processParsedEvent(parsed);
        return;
      }
      if (/image/i.test(ct) || /\.(jpg|jpeg|png)$/i.test(name)) {
        const eventId = lastPendingFaceEventId;
        if (eventId == null) {
          logger.warn("[ISAPI] 收到附圖但無待綁定事件", {
            deviceId,
            deviceIp,
          });
          return;
        }
        lastPendingFaceEventId = null;
        await attachPictureToEvent(eventId, body);
      }
    },
    onPartError: (err) => {
      logger.warn("[ISAPI] 處理事件片段失敗", {
        deviceId,
        deviceIp,
        error: err?.message || String(err),
      });
    },
    onBeforeResolve: () => {
      if (lastPendingFaceEventId != null) {
        logger.warn("[ISAPI] 串流結束仍有未配對附圖的事件", {
          deviceId,
          deviceIp,
          eventId: lastPendingFaceEventId,
        });
        lastPendingFaceEventId = null;
      }
    },
  });
}

/**
 * 處理單一設備訂閱：發送訂閱、長連線增量解析事件，連線斷開後拋出以便重連
 */
async function runSubscribeForDevice(deviceId, abortSignal) {
  if (abortSignal?.aborted) {
    throw createApiError(C.ACCESS_CONTROL_ABORTED, "ABORTED");
  }
  const { device, client } =
    await accessControlService.getDeviceAndClient(deviceId);
  const deviceIp = device.config?.host || "";
  await isapiTimeSyncService.syncOnConnect(device);

  const res = await client.requestSubscribeStream(SUBSCRIBE_XML);
  const contentType = res.headers["content-type"] || "";
  const stream = res.data;
  connectedDeviceIds.add(deviceId);
  try {
    await consumeEventStreamIncremental(
      stream,
      contentType,
      deviceIp,
      deviceId,
      abortSignal,
    );
  } finally {
    connectedDeviceIds.delete(deviceId);
    // 先關掉這一條，再讓迴圈隔 10 秒重連，避免同一台同時兩條 subscribeEvent
    if (stream && !stream.destroyed) stream.destroy();
  }
}

const manager = createSubscribeManager({
  logger,
  keyOf: (deviceId) => deviceId,
  listTargets: getDeviceIdsToSubscribe,
  runOnce: runSubscribeForDevice,
  refreshPolicy: "eager",
  onStreamEnded: (deviceId) => {
    logger.warn("[ISAPI] 訂閱串流結束，將重連", { deviceId });
  },
  onReconnectError: (deviceId, error) => {
    logger.warn("[ISAPI] 訂閱連線中斷，將重連", {
      deviceId,
      error: error?.message || String(error),
      statusCode: error?.statusCode ?? null,
    });
  },
  onRefresh: ({ targets, toStart, toStop }) => {
    if (toStart.length === 0 && toStop.length === 0) return;
    const refreshMeta = { count: targets.length };
    if (toStart.length > 0) refreshMeta.start = toStart.join(",");
    if (toStop.length > 0) refreshMeta.stop = toStop.join(",");
    logger.info("[ISAPI] 訂閱刷新完成", refreshMeta);
  },
  buildStatus: ({ started, targets }) => ({
    started,
    deviceIds: [...targets],
    connectedDeviceIds: [...connectedDeviceIds].sort((a, b) => a - b),
  }),
  buildRefreshResult: ({ started, targets }) => ({
    started,
    deviceIds: [...targets],
  }),
});

function stop() {
  connectedDeviceIds.clear();
  manager.stop();
}

module.exports = {
  start: manager.start,
  stop,
  refresh: manager.refresh,
  getSubscribeStatus: manager.getSubscribeStatus,
  getDeviceIdsToSubscribe,
};
