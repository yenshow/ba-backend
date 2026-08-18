/**
 * VIS 管理中心主機 SDK 佈防（層 1 → operational_events intercom）
 */
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("VideoIntercomArming");
const { spawnArmingProcess } = require("../ladderSdk/sdkBridgeClient");
const { resolveSdkCredentials } = require("../ladderSdk/sdkLadderDeviceService");
const deviceService = require("../devices/deviceService");
const operationalEventService = require("../operationalEvents/operationalEventService");

/** 延遲載入，避免與 accessSecurityService 循環引用 */
const resolveLocationByVoipOrHost = (...args) =>
  require("./accessSecurityService").resolveLocationByVoipOrHost(...args);

const RE_CONNECT_DELAY_MS = 10_000;

/** @type {Map<number, { child: import('child_process').ChildProcess, startedAt: number, status: string, generation: number }>} */
const deviceProcesses = new Map();
const deviceGenerations = new Map();

const bumpDeviceGeneration = (deviceId) => {
  const next = (deviceGenerations.get(deviceId) || 0) + 1;
  deviceGenerations.set(deviceId, next);
  return next;
};

const isDeviceGenerationCurrent = (deviceId, generation) =>
  (deviceGenerations.get(deviceId) || 0) === generation;

const resolveLocationIdForPayload = async (payload) => {
  // 嘗試從事件 payload 找室內機 IP／號碼對應地點（最佳努力）
  const hit = await resolveLocationByVoipOrHost({
    voipNumber:
      payload?.roomNo ||
      payload?.roomNumber ||
      payload?.unitNumber ||
      payload?.voipNumber ||
      payload?.deviceNumber ||
      null,
    host: payload?.sourceIp || payload?.host || null,
  });
  return hit?.locationId ?? null;
};

const handleEvent = async (deviceId, device, message) => {
  const eventTime = message.timestamp || new Date().toISOString();
  const eventName = message.eventName || message.type || "intercom";
  let locationId = null;
  try {
    locationId = await resolveLocationIdForPayload(message);
  } catch {
    /* ignore */
  }

  try {
    await operationalEventService.recordEvent({
      occurred_at: eventTime,
      source: "video_intercom",
      event_kind: "intercom",
      location_id: locationId,
      device_id: deviceId,
      summary: `對講組網事件：${eventName}`,
      payload: {
        layer: 1,
        ...message,
        deviceId,
        deviceName: device?.name || "",
        timestamp: eventTime,
      },
    });
  } catch (error) {
    logger.warn("對講事件寫入失敗", {
      deviceId,
      error: error?.message || String(error),
    });
  }
};

const stopDevice = (deviceId) => {
  bumpDeviceGeneration(deviceId);
  const entry = deviceProcesses.get(deviceId);
  if (!entry) return;
  try {
    entry.child.kill();
  } catch {
    // ignore
  }
  deviceProcesses.delete(deviceId);
};

const startDeviceLoop = async (deviceId) => {
  if (deviceProcesses.has(deviceId)) return;

  const generation = bumpDeviceGeneration(deviceId);

  let device;
  let credentials;
  try {
    const result = await deviceService.getDeviceById(deviceId);
    device = result.device;
    credentials = resolveSdkCredentials(device);
  } catch (error) {
    logger.warn("對講佈防略過設備", {
      deviceId,
      error: error?.message || String(error),
    });
    return;
  }

  const connect = () => {
    if (!isDeviceGenerationCurrent(deviceId, generation)) return;
    if (deviceProcesses.has(deviceId)) return;

    const child = spawnArmingProcess(
      credentials,
      {
        onReady: () => {
          logger.info("對講主機佈防就緒", { deviceId, host: credentials.host });
          const entry = deviceProcesses.get(deviceId);
          if (entry) entry.status = "ready";
        },
        onEvent: (message) => {
          void handleEvent(deviceId, device, message);
        },
        onError: (message) => {
          logger.warn("對講佈防錯誤", { deviceId, message });
        },
        onClose: (code) => {
          deviceProcesses.delete(deviceId);
          if (!isDeviceGenerationCurrent(deviceId, generation)) return;
          logger.warn("對講佈防程序結束，將重連", { deviceId, code });
          setTimeout(() => {
            if (!isDeviceGenerationCurrent(deviceId, generation)) return;
            connect();
          }, RE_CONNECT_DELAY_MS);
        },
      },
      { args: ["--arming-intercom"] },
    );

    deviceProcesses.set(deviceId, {
      child,
      startedAt: Date.now(),
      status: "connecting",
      generation,
    });
  };

  connect();
};

const getManageStationIds = async () => {
  const rows = await db.query(
    `
    SELECT id
    FROM devices
    WHERE type_code = 'video_intercom'
      AND COALESCE(config->>'unitType', '') = 'manage'
    `,
  );
  return (rows || [])
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n) && n > 0);
};

const start = async () => {
  const ids = await getManageStationIds();
  logger.debug("啟動對講主機佈防", { count: ids.length });
  await Promise.all(ids.map((id) => startDeviceLoop(id)));
  return { started: true, deviceIds: ids };
};

const reconcile = async () => {
  const desired = await getManageStationIds();
  const desiredSet = new Set(desired);
  const current = [...deviceProcesses.keys()];

  const toStop = current.filter((deviceId) => !desiredSet.has(deviceId));
  const toStart = desired.filter((deviceId) => !deviceProcesses.has(deviceId));

  if (toStop.length === 0 && toStart.length === 0) {
    return { deviceIds: desired };
  }

  for (const deviceId of toStop) stopDevice(deviceId);
  await Promise.all(toStart.map((deviceId) => startDeviceLoop(deviceId)));

  if (toStart.length > 0 || toStop.length > 0) {
    logger.info("對講主機佈防刷新完成", {
      count: desired.length,
      start: toStart.length ? toStart.join(",") : undefined,
      stop: toStop.length ? toStop.join(",") : undefined,
    });
  }

  return { deviceIds: desired };
};

const stop = () => {
  for (const deviceId of [...deviceProcesses.keys()]) {
    stopDevice(deviceId);
  }
};

const getStatus = () => ({
  devices: Array.from(deviceProcesses.entries()).map(([deviceId, entry]) => ({
    deviceId,
    status: entry.status,
    startedAt: entry.startedAt,
    pid: entry.child.pid,
  })),
});

module.exports = {
  start,
  stop,
  reconcile,
  getStatus,
};
