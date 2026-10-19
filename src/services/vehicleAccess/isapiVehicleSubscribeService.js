/**
 * 車輛 ISAPI ANPR 佈防訂閱（eventMode=all，程式內篩選 ANPR）
 * 長連線骨架：../isapi/isapiSubscribeLoop
 */
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const logger = require("../../utils/logger").createLogger(
  "ISAPI Vehicle Subscribe",
);
const db = require("../../database/db");
const { parseAnprEventXml } = require("./isapiVehicleXmlParser");
const {
  persistAnprEvent,
  attachLicensePlatePicture,
  runFanOutPictureBackfillOnce,
} = require("./isapiVehiclePersistence");
const { ensureIntArray } = require("../location/locationShared");
const isapiTimeSyncService = require("../isapi/isapiTimeSyncService");
const {
  scheduleVehicleEventBackfill,
} = require("./isapiVehicleEventBackfillService");
const {
  parseEventBackfillFields,
} = require("../isapi/isapiEventBackfillCommon");
const {
  createSubscribeManager,
  consumeMultipartEventStream,
} = require("../isapi/isapiSubscribeLoop");

const SUBSCRIBE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <heartbeat>30</heartbeat>
    <eventMode>all</eventMode>
</SubscribeEvent>`;

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
    const backfill = parseEventBackfillFields(cfg);
    const target = {
      locationId: Number(r.location_id),
      locationName: r.location_name || "",
      zoneName: r.zone_name || "",
      eventBackfillEnabled: backfill.eventBackfillEnabled,
      eventBackfillWindowSec: backfill.eventBackfillWindowSec,
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
  const {
    filterEnabledDeviceIds,
  } = require("../devices/deviceEnabledFilter");
  const enabledIds = await filterEnabledDeviceIds(Array.from(map.keys()));
  const enabledSet = new Set(enabledIds);
  const filtered = new Map();
  for (const [deviceId, targets] of map.entries()) {
    if (!enabledSet.has(deviceId)) continue;
    filtered.set(deviceId, targets);
  }
  deviceLocationMap = filtered;
  return enabledIds;
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
  return {
    device,
    client: createIsapiClient(device.config, { typeCode: device.type_code }),
  };
}

async function consumeEventStreamIncremental(
  stream,
  contentType,
  deviceId,
  abortSignal,
) {
  let pendingPicture = { logIds: [], attachFirstImage: false };

  await consumeMultipartEventStream({
    stream,
    contentType,
    abortSignal,
    preferContentLength: false,
    onPart: async (headerStr, body) => {
      const ct =
        (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || "";
      const rawBody = body
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trim();

      if (
        /xml/i.test(ct) ||
        (rawBody.startsWith("<") && rawBody.includes("eventType"))
      ) {
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
        scheduleVehicleEventBackfill({
          deviceId,
          eventTime: parsed.dateTime,
          locationTargets: targets,
        });
        return;
      }

      if (/image/i.test(ct)) {
        if (
          !pendingPicture.attachFirstImage ||
          pendingPicture.logIds.length === 0
        ) {
          return;
        }
        pendingPicture.attachFirstImage = false;
        await attachLicensePlatePicture(pendingPicture.logIds, body);
      }
    },
    onPartError: (err) => {
      logger.warn("[ISAPI Vehicle] part 處理失敗", {
        deviceId,
        message: err?.message || String(err),
      });
    },
  });
}

async function runSubscribeForDevice(deviceId, abortSignal) {
  if (abortSignal?.aborted) return;
  const { device, client } = await getDeviceClient(deviceId);
  await isapiTimeSyncService.syncOnConnect(device);
  const res = await client.requestSubscribeStream(SUBSCRIBE_XML);
  const contentType = res.headers["content-type"] || "";
  await consumeEventStreamIncremental(
    res.data,
    contentType,
    deviceId,
    abortSignal,
  );
}

const manager = createSubscribeManager({
  logger,
  keyOf: (deviceId) => deviceId,
  listTargets: getDeviceIdsToSubscribe,
  runOnce: runSubscribeForDevice,
  // Hub reconcile 只呼叫 refresh；首次需與 start 相同（fan-out 後再啟迴圈）
  refreshPolicy: "strict",
  onStreamEnded: (deviceId) => {
    logger.warn("[ISAPI Vehicle] 訂閱串流結束，將重連", { deviceId });
  },
  onReconnectError: (deviceId, error) => {
    logger.warn("[ISAPI Vehicle] 訂閱連線中斷，將重連", {
      deviceId,
      error: error?.message || String(error),
      statusCode: error?.statusCode ?? null,
    });
  },
  onRefresh: ({ targets }) => {
    logger.info("[ISAPI Vehicle] 訂閱刷新", { count: targets.length });
  },
  buildStatus: ({ started, targets }) => ({
    started,
    deviceIds: [...targets],
  }),
  buildRefreshResult: ({ started, targets }) => ({
    started,
    deviceIds: [...targets],
  }),
});

async function runFanOutHook() {
  try {
    const count = await runFanOutPictureBackfillOnce();
    if (count > 0) {
      logger.info("[ISAPI Vehicle] 已回填 fan-out 缺圖列", { count });
    }
  } catch (error) {
    logger.warn("[ISAPI Vehicle] fan-out 缺圖回填失敗", {
      message: error?.message || String(error),
    });
  }
}

/**
 * Hub 僅呼叫 refresh：尚未 started 時等同 start（含 fan-out），避免車輛佈防永不啟動。
 */
async function refresh() {
  if (!manager.getStarted()) {
    await manager.startWithBeforeRefresh(runFanOutHook);
    return {
      started: true,
      deviceIds: [...manager.getRunningTargets()],
    };
  }
  return manager.refresh();
}

module.exports = {
  start: refresh,
  stop: manager.stop,
  refresh,
  getSubscribeStatus: manager.getSubscribeStatus,
  getDeviceIdsToSubscribe,
};
