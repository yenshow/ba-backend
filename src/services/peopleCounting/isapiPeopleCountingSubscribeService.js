/**
 * ISAPI 攝影機佈防訂閱服務（subscribeEvent 長連線）
 * - people_counting：訂 PeopleCounting → isapi_people_counting_events
 * - face_recognition：訂 faceCapture + alarmResult → 僅落地有候選人的 alarmResult
 *
 * faceCapture：部分機型需訂閱才會推人臉／比對串流；平台不解析、不寫入。
 * alarmResult 有候選人時落地，multipart 後續 image part 寫入 picture_path。
 * 人流僅落地 statisticalMethods=realTime 之分區列。
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
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
const {
  parseFaceContrastEventPayload,
} = require("./isapiFaceContrastXmlParser");
const { persistFaceContrastEvent, attachPictureToFaceContrastEvent } = require("./isapiFaceContrastPersistence");

const RE_CONNECT_DELAY_MS = 10000;

function ensureInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function buildSubscribeXml(
  channelId,
  { includePeopleCounting = true, includeFaceContrast = false } = {},
) {
  const ch = ensureInt(channelId) ?? 1;
  const events = [];
  if (includePeopleCounting) {
    events.push(`
    <Event>
      <type>PeopleCounting</type>
      <channels>${ch}</channels>
    </Event>`);
  }
  if (includeFaceContrast) {
    // faceCapture：現場機型需訂才會推 alarmResult；業務仍只落地有候選人的比對
    events.push(`
    <Event>
      <type>faceCapture</type>
      <channels>${ch}</channels>
    </Event>
    <Event>
      <type>alarmResult</type>
      <channels>${ch}</channels>
    </Event>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <heartbeat>30</heartbeat>
  <channelMode>list</channelMode>
  <eventMode>list</eventMode>
  <EventList>${events.join("")}
  </EventList>
</SubscribeEvent>`;
}

/**
 * 取得需訂閱的攝影機設定（people_counting 地點、data_source=isapi_camera）
 * @returns {Promise<Array<{ locationId:number, deviceId:number, channelId:number, includePeopleCounting:boolean, includeFaceContrast:boolean, direction:'entry'|'exit'|null }>>}
 */
async function getCameraSubscriptions() {
  const {
    resolvePeopleCountingCameraDevices,
    resolveFaceCameraDirection,
    CAMERA_MODE,
  } = require("./peopleCountingConfig");

  const rows = await db.query(
    `SELECT
       ls.location_id AS location_id,
       ls.system_config AS system_config
     FROM location_systems ls
     WHERE ls.system_type = 'people_counting'
       AND (ls.system_config->>'data_source') = 'isapi_camera'`,
    [],
  );
  const subs = [];
  for (const r of rows || []) {
    const locationId = ensureInt(r.location_id);
    const channelId = 1;
    if (!locationId) continue;
    const cfg =
      typeof r.system_config === "string"
        ? (() => {
            try {
              return JSON.parse(r.system_config);
            } catch {
              return {};
            }
          })()
        : r.system_config || {};
    const cameras = resolvePeopleCountingCameraDevices(cfg);
    const isFace = cameras.cameraMode === CAMERA_MODE.FACE_RECOGNITION;
    const includeFaceContrast = isFace;
    const includePeopleCounting = !isFace;
    const deviceIds = cameras.cameraDeviceIds;

    for (const deviceId of deviceIds) {
      if (!deviceId) continue;
      const direction = isFace
        ? resolveFaceCameraDirection(deviceId, cameras)
        : null;
      subs.push({
        locationId,
        deviceId,
        channelId,
        includePeopleCounting,
        includeFaceContrast,
        direction,
      });
    }
  }
  // 去重：同一地點/設備/頻道只訂閱一次
  const uniq = new Map();
  for (const s of subs) {
    const key = `${s.locationId}:${s.deviceId}:${s.channelId}`;
    const prev = uniq.get(key);
    if (!prev) {
      uniq.set(key, s);
      continue;
    }
    uniq.set(key, {
      ...prev,
      includePeopleCounting:
        prev.includePeopleCounting || s.includePeopleCounting,
      includeFaceContrast: prev.includeFaceContrast || s.includeFaceContrast,
      direction: prev.direction || s.direction,
    });
  }
  return [...uniq.values()].filter(
    (s) => s.includePeopleCounting || s.includeFaceContrast,
  );
}

async function getDeviceClient(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  if (
    !device?.config?.host ||
    !device?.config?.username ||
    !device?.config?.password
  ) {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "攝影機連線設定不完整（缺少 host / username / password）",
    );
  }
  const client = createIsapiClient(device.config);
  return { device, client };
}

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");

function subKey(sub) {
  return `${sub.locationId}:${sub.deviceId}:${sub.channelId}:pc=${sub.includePeopleCounting ? 1 : 0}:fc=${sub.includeFaceContrast ? 1 : 0}:dir=${sub.direction || "-"}`;
}

async function consumeEventStreamIncremental(
  stream,
  contentType,
  context,
  abortSignal,
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
  /** @type {number|null} 剛寫入的人臉比對事件，供下一 image part 補圖 */
  let lastWrittenFaceEventId = null;
  /** 依序處理 multipart，避免事件寫入未完成就丟附圖 */
  let processChain = Promise.resolve();

  const processPart = async (headerStr, body) => {
    const ct = (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";
    const name =
      (headerStr.match(/Content-Disposition[^;]*name="([^"]+)"/i) || [])[1] ||
      "";

    // 附圖（multipart 順序：先 alarmResult JSON，後 image/*）
    if (
      /image/i.test(ct) ||
      (/\.(jpg|jpeg|png)$/i.test(name) && lastWrittenFaceEventId != null)
    ) {
      if (lastWrittenFaceEventId != null) {
        const eventId = lastWrittenFaceEventId;
        lastWrittenFaceEventId = null;
        try {
          const picturePath = await attachPictureToFaceContrastEvent(
            eventId,
            body,
          );
          if (picturePath) {
            logger.info("[ISAPI FaceContrast] 已補附圖", {
              locationId: context.locationId,
              deviceId: context.deviceId,
              id: eventId,
              picturePath,
            });
          }
        } catch (err) {
          logger.warn("[ISAPI FaceContrast] 附圖寫入失敗", {
            locationId: context.locationId,
            deviceId: context.deviceId,
            id: eventId,
            error: err?.message || String(err),
          });
        }
      }
      return;
    }

    const raw = body
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trim();
    if (!/xml|json/i.test(ct) && raw.length === 0) return;

    // 略過保活（無業務 eventType 或 heartbeat）
    const quickType =
      (raw.match(/"eventType"\s*:\s*"([^"]+)"/i) || [])[1] ||
      (raw.match(/<eventType>([^<]+)<\/eventType>/i) || [])[1] ||
      "";
    const quickTypeLower = String(quickType).toLowerCase();
    if (
      !quickTypeLower ||
      quickTypeLower === "heartbeat" ||
      quickTypeLower === "heart beat"
    ) {
      return;
    }

    // 人臉比對：僅 face_recognition 落地 alarmResult（有候選人）
    if (context.includeFaceContrast) {
      const faceParsed = parseFaceContrastEventPayload(raw);
      if (faceParsed?.eventTime) {
        try {
          const saved = await persistFaceContrastEvent({
            locationId: context.locationId,
            deviceId: context.deviceId,
            deviceIp: faceParsed.deviceIp || context.deviceIp || "",
            channelId: faceParsed.channelId ?? context.channelId ?? 1,
            eventTime: faceParsed.eventTime,
            eventType: faceParsed.eventType,
            similarity: faceParsed.similarity,
            employeeNo: faceParsed.employeeNo,
            personName: faceParsed.personName,
            pid: faceParsed.pid,
            certificateNumber: faceParsed.certificateNumber,
            matched: faceParsed.matched,
            faceLibName: faceParsed.faceLibName,
            direction: context.direction || null,
          });
          if (saved?.id != null) {
            lastWrittenFaceEventId = Number(saved.id);
          }
          logger.info("[ISAPI FaceContrast] 已寫入比對事件", {
            locationId: context.locationId,
            deviceId: context.deviceId,
            id: saved?.id ?? null,
            personName: saved?.personName ?? faceParsed.personName,
            employeeNo: saved?.employeeNo ?? faceParsed.employeeNo,
            similarity: faceParsed.similarity,
          });
        } catch (err) {
          lastWrittenFaceEventId = null;
          logger.warn("[ISAPI FaceContrast] 寫入失敗", {
            locationId: context.locationId,
            deviceId: context.deviceId,
            error: err?.message || String(err),
          });
        }
        return;
      }
    }

    if (!context.includePeopleCounting) return;

    const parsed = parsePeopleCountingEventXml(raw);
    if (!parsed || !parsed.eventTime) {
      logger.debug?.("[ISAPI PeopleCounting] 略過未辨識事件", {
        deviceId: context.deviceId,
        eventType: quickType || "(none)",
        contentType: ct || "(unknown)",
      });
      return;
    }

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
    if (regions.length > 0) {
      logger.debug("[ISAPI PeopleCounting] 已寫入人流事件", {
        locationId: context.locationId,
        deviceId: context.deviceId,
        eventTime: parsed.eventTime,
        regionCount: regions.length,
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
    processChain = processChain
      .then(() => processPart(headerStr, body))
      .catch((err) => {
        logger.warn("[ISAPI PeopleCounting] 處理事件片段失敗", {
          locationId: context.locationId,
          deviceId: context.deviceId,
          error: err?.message || String(err),
        });
      });
    buffer = buffer.slice(bodyEnd);
    return true;
  };

  return new Promise((resolve, reject) => {
    const abortHandler = () => {
      try {
        stream.destroy(new Error("ABORTED"));
      } catch (_e) {}
    };
    if (abortSignal) {
      if (abortSignal.aborted) abortHandler();
      else abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

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

async function runSubscribeForCamera(sub, abortSignal) {
  if (abortSignal?.aborted) return;
  const { device, client } = await getDeviceClient(sub.deviceId);
  const deviceIp = device?.config?.host || "";
  const includePeopleCounting = Boolean(sub.includePeopleCounting);
  const includeFaceContrast = Boolean(sub.includeFaceContrast);
  const direction =
    sub.direction === "entry" || sub.direction === "exit"
      ? sub.direction
      : null;
  logger.info("[ISAPI PeopleCounting] 開始佈防訂閱", {
    locationId: sub.locationId,
    deviceId: sub.deviceId,
    deviceIp,
    channelId: sub.channelId,
    includePeopleCounting,
    includeFaceContrast,
    direction,
  });
  const res = await client.requestSubscribeStream(
    buildSubscribeXml(sub.channelId, {
      includePeopleCounting,
      includeFaceContrast,
    }),
  );
  const contentType = res.headers["content-type"] || "";
  logger.info("[ISAPI PeopleCounting] 佈防連線已建立", {
    locationId: sub.locationId,
    deviceId: sub.deviceId,
    deviceIp,
    status: res.status,
    contentType,
    includePeopleCounting,
    includeFaceContrast,
    direction,
  });
  const stream = res.data;
  await consumeEventStreamIncremental(
    stream,
    contentType,
    {
      locationId: sub.locationId,
      deviceId: sub.deviceId,
      deviceIp,
      channelId: sub.channelId,
      includePeopleCounting,
      includeFaceContrast,
      direction,
    },
    abortSignal,
  );
  logger.warn("[ISAPI PeopleCounting] 佈防連線結束，將重連", {
    locationId: sub.locationId,
    deviceId: sub.deviceId,
    deviceIp,
  });
}

async function subscribeLoop(sub, abortSignal) {
  for (;;) {
    if (abortSignal?.aborted) return;
    try {
      await runSubscribeForCamera(sub, abortSignal);
    } catch (e) {
      if (abortSignal?.aborted) return;
      if (e && (e.code === "ABORTED" || String(e.message).includes("ABORTED")))
        return;
      logger.warn("[ISAPI PeopleCounting] 佈防訂閱失敗，將重試", {
        locationId: sub.locationId,
        deviceId: sub.deviceId,
        includePeopleCounting: Boolean(sub.includePeopleCounting),
        includeFaceContrast: Boolean(sub.includeFaceContrast),
        error: e?.message || String(e),
      });
    }
    if (abortSignal?.aborted) return;
    await new Promise((r) => setTimeout(r, RE_CONNECT_DELAY_MS));
  }
}

/** @type {Map<string, { controller: AbortController, startedAt: number }>} */
const subLoopControllers = new Map();

let started = false;
let runningSubs = [];

function startLoopForSub(sub) {
  const key = subKey(sub);
  if (subLoopControllers.has(key)) return;
  const controller = new AbortController();
  subLoopControllers.set(key, { controller, startedAt: Date.now() });
  subscribeLoop(sub, controller.signal);
}

function stopLoopForSub(sub) {
  const key = subKey(sub);
  const entry = subLoopControllers.get(key);
  if (!entry) return;
  try {
    entry.controller.abort();
  } catch (_e) {}
  subLoopControllers.delete(key);
}

async function start() {
  if (started) return;
  await refresh();
}

function stop() {
  started = false;
  const subsToStop = [...runningSubs];
  runningSubs = [];
  for (const sub of subsToStop) {
    stopLoopForSub(sub);
  }
}

/**
 * 重新計算需訂閱的攝影機，增量啟停訂閱迴圈
 */
async function refresh() {
  if (!started) {
    started = true;
  }
  const subs = await getCameraSubscriptions();
  const nextKeys = new Set(subs.map(subKey));
  const prevKeys = new Set(runningSubs.map(subKey));

  const toStart = subs.filter((sub) => !prevKeys.has(subKey(sub)));
  const toStop = runningSubs.filter((sub) => !nextKeys.has(subKey(sub)));

  for (const sub of toStop) stopLoopForSub(sub);
  for (const sub of toStart) startLoopForSub(sub);

  runningSubs = subs;
  if (toStart.length > 0 || toStop.length > 0) {
    logger.info("[ISAPI PeopleCounting] 訂閱刷新", {
      count: subs.length,
      start: toStart.length,
      stop: toStop.length,
    });
  } else {
    logger.debug("[ISAPI PeopleCounting] 訂閱刷新（無變更）", {
      count: subs.length,
    });
  }
  return { started: true, subs: [...runningSubs] };
}

function getSubscribeStatus() {
  return { started, subs: [...runningSubs] };
}

module.exports = {
  start,
  stop,
  refresh,
  getSubscribeStatus,
};
