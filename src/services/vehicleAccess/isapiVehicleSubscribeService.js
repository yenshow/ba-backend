/**
 * 車輛 ISAPI ANPR 佈防訂閱（eventMode=all，程式內篩選 ANPR）
 */
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const logger = require("../../utils/logger").createLogger("ISAPI Vehicle Subscribe");
const db = require("../../database/db");
const { parseAnprEventXml } = require("./isapiVehicleXmlParser");
const {
  persistAnprEvent,
  attachLicensePlatePicture,
  ensureUploadsDir,
} = require("./isapiVehiclePersistence");
const { ensureIntArray } = require("../location/locationShared");

const SUBSCRIBE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <heartbeat>30</heartbeat>
    <eventMode>all</eventMode>
</SubscribeEvent>`;

const RE_CONNECT_DELAY_MS = 10000;
const deviceLoopControllers = new Map();
let started = false;
let subscribedDeviceIds = [];
let deviceLocationMap = new Map();

async function loadDeviceLocationMap() {
  const rows = await db.query(
    `
      SELECT
        l.id AS location_id,
        l.name AS location_name,
        z.name AS zone_name,
        ls.system_config
      FROM location_systems ls
      INNER JOIN locations l ON l.id = ls.location_id
      INNER JOIN zones z ON z.id = l.zone_id
      WHERE ls.system_type = 'vehicle_access'
        AND COALESCE(ls.system_config->>'data_source', 'yscp') = 'isapi_camera'
    `,
    [],
  );
  const map = new Map();
  for (const r of rows || []) {
    const cfg = r.system_config || {};
    const entryIds = ensureIntArray(cfg.entry_camera_device_ids);
    const exitIds = ensureIntArray(cfg.exit_camera_device_ids);
    const target = {
      locationId: Number(r.location_id),
      locationName: r.location_name || "",
      zoneName: r.zone_name || "",
    };
    for (const deviceId of entryIds) {
      if (!map.has(deviceId)) map.set(deviceId, []);
      map.get(deviceId).push({ ...target, laneType: 1 });
    }
    for (const deviceId of exitIds) {
      if (!map.has(deviceId)) map.set(deviceId, []);
      map.get(deviceId).push({ ...target, laneType: 2 });
    }
  }
  return map;
}

async function getDeviceIdsToSubscribe() {
  const map = await loadDeviceLocationMap();
  deviceLocationMap = map;
  return Array.from(map.keys());
}

async function getDeviceClient(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  if (
    !device?.config?.host ||
    !device?.config?.username ||
    !device?.config?.password
  ) {
    throw new Error("攝影機連線設定不完整");
  }
  return { device, client: createIsapiClient(device.config) };
}

const CRLF = Buffer.from("\r\n");
const CRLFCRLF = Buffer.from("\r\n\r\n");

async function consumeEventStreamIncremental(
  stream,
  contentType,
  deviceId,
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
  let pendingPicture = { logIds: [], attachFirstImage: false };
  let partChain = Promise.resolve();

  const enqueuePart = (fn) => {
    partChain = partChain.then(fn).catch((err) => {
      logger.warn("[ISAPI Vehicle] part 處理失敗", {
        deviceId,
        message: err?.message || String(err),
      });
    });
  };

  const processPart = (headerStr, body) => {
    const ct = (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";
    const rawBody = body
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trim();

    if (/xml/i.test(ct) || (rawBody.startsWith("<") && rawBody.includes("eventType"))) {
      enqueuePart(async () => {
        const parsed = parseAnprEventXml(rawBody);
        if (!parsed) return;
        const targets = deviceLocationMap.get(deviceId) || [];
        if (targets.length === 0) return;
        const res = await persistAnprEvent({
          parsed,
          deviceId,
          locationTargets: targets,
        });
        if (!res.inserted) return;
        logger.info("[ISAPI Vehicle] 已寫入 ANPR", {
          deviceId,
          plate: parsed.licensePlate,
          count: res.ids.length,
        });
        pendingPicture = { logIds: res.ids, attachFirstImage: true };
      });
      return;
    }

    if (/image/i.test(ct)) {
      enqueuePart(async () => {
        if (!pendingPicture.attachFirstImage || pendingPicture.logIds.length === 0) return;
        pendingPicture.attachFirstImage = false;
        await attachLicensePlatePicture(pendingPicture.logIds[0], body);
      });
    }
  };

  const tryConsumeOnePart = () => {
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
      start = 0;
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
    processPart(headerStr, body);
    buffer = buffer.slice(next);
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
    stream.on("end", () => {
      partChain.finally(() => resolve());
    });
    stream.on("close", () => {
      partChain.finally(() => resolve());
    });
  });
}

async function runSubscribeForDevice(deviceId, abortSignal) {
  if (abortSignal?.aborted) return;
  const { device, client } = await getDeviceClient(deviceId);
  const res = await client.requestSubscribeStream(SUBSCRIBE_XML);
  const contentType = res.headers["content-type"] || "";
  await consumeEventStreamIncremental(
    res.data,
    contentType,
    deviceId,
    abortSignal,
  );
}

async function subscribeLoop(deviceId, abortSignal) {
  for (;;) {
    if (abortSignal?.aborted) return;
    try {
      await runSubscribeForDevice(deviceId, abortSignal);
    } catch (e) {
      if (abortSignal?.aborted) return;
      if (e && String(e.message || "").includes("ABORTED")) return;
    }
    if (abortSignal?.aborted) return;
    await new Promise((r) => setTimeout(r, RE_CONNECT_DELAY_MS));
  }
}

function startLoopForDevice(deviceId) {
  if (deviceLoopControllers.has(deviceId)) return;
  const controller = new AbortController();
  deviceLoopControllers.set(deviceId, { controller, startedAt: Date.now() });
  subscribeLoop(deviceId, controller.signal);
}

function stopLoopForDevice(deviceId) {
  const entry = deviceLoopControllers.get(deviceId);
  if (!entry) return;
  try {
    entry.controller.abort();
  } catch (_e) {}
  deviceLoopControllers.delete(deviceId);
}

async function start() {
  if (started) return;
  ensureUploadsDir();
  started = true;
  await refresh();
}

function stop() {
  started = false;
  subscribedDeviceIds = [];
  for (const deviceId of [...deviceLoopControllers.keys()]) {
    stopLoopForDevice(deviceId);
  }
}

async function refresh() {
  if (!started) return { started: false, deviceIds: [] };
  ensureUploadsDir();
  const deviceIds = await getDeviceIdsToSubscribe();
  const nextSet = new Set(deviceIds);
  const prevSet = new Set(subscribedDeviceIds);
  const toStart = deviceIds.filter((id) => !prevSet.has(id));
  const toStop = subscribedDeviceIds.filter((id) => !nextSet.has(id));
  for (const id of toStop) stopLoopForDevice(id);
  for (const id of toStart) startLoopForDevice(id);
  subscribedDeviceIds = deviceIds;
  logger.info("[ISAPI Vehicle] 訂閱刷新", { count: deviceIds.length });
  return { started: true, deviceIds: [...subscribedDeviceIds] };
}

function getSubscribeStatus() {
  return { started, deviceIds: [...subscribedDeviceIds] };
}

module.exports = {
  start,
  stop,
  refresh,
  getSubscribeStatus,
  getDeviceIdsToSubscribe,
};
