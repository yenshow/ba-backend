/**
 * 梯控 SDK 佈防常駐服務（事件白名單由 sdkEventPersistence 套用）
 */
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("Ladder SDK Arming");
const { spawnArmingProcess } = require("./sdkBridgeClient");
const { resolveSdkCredentials } = require("./sdkLadderDeviceService");
const { persistLadderSdkEvent } = require("./sdkEventPersistence");
const deviceService = require("../devices/deviceService");

const RE_CONNECT_DELAY_MS = 10_000;
/** 主動 refresh 後等待設備釋放佈防資源（SDK 1924） */
const REFRESH_SETTLE_MS = 2_000;

/** @type {Map<number, { child: import('child_process').ChildProcess, startedAt: number, status: string, generation: number }>} */
const deviceProcesses = new Map();

/** 遞增後可使該設備既有 onClose 重連排程失效 */
const deviceGenerations = new Map();

const bumpDeviceGeneration = (deviceId) => {
  const next = (deviceGenerations.get(deviceId) || 0) + 1;
  deviceGenerations.set(deviceId, next);
  return next;
};

const isDeviceGenerationCurrent = (deviceId, generation) =>
  (deviceGenerations.get(deviceId) || 0) === generation;

const handleEvent = async (deviceId, device, message) => {
  const eventTime = message.timestamp || new Date().toISOString();
  try {
    await persistLadderSdkEvent({
      deviceId,
      deviceIp: device?.config?.host || "",
      eventTime,
      major: message.major,
      minor: message.minor,
      eventName: message.eventName,
      floor: message.floor ?? null,
      cardNo: message.cardNo ?? null,
      payload: {
        ...message,
        deviceId,
        deviceName: device?.name || "",
        timestamp: eventTime,
      },
    });
  } catch (error) {
    logger.warn("梯控事件寫入失敗", {
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
  if (deviceProcesses.has(deviceId)) {
    return;
  }

  const generation = bumpDeviceGeneration(deviceId);

  let device;
  let credentials;
  try {
    const result = await deviceService.getDeviceById(deviceId);
    device = result.device;
    credentials = resolveSdkCredentials(device);
  } catch (error) {
    logger.warn("梯控佈防略過設備", {
      deviceId,
      error: error?.message || String(error),
    });
    return;
  }

  const connect = () => {
    if (!isDeviceGenerationCurrent(deviceId, generation)) return;
    if (deviceProcesses.has(deviceId)) return;

    const child = spawnArmingProcess(credentials, {
      onReady: () => {
        logger.info("梯控佈防就緒", { deviceId, host: credentials.host });
        const entry = deviceProcesses.get(deviceId);
        if (entry) entry.status = "ready";
      },
      onEvent: (message) => {
        void handleEvent(deviceId, device, message);
      },
      onError: (message) => {
        logger.warn("梯控佈防錯誤", { deviceId, message });
      },
      onClose: (code) => {
        deviceProcesses.delete(deviceId);
        if (!isDeviceGenerationCurrent(deviceId, generation)) return;
        logger.warn("梯控佈防程序結束，將重連", { deviceId, code });
        setTimeout(() => {
          if (!isDeviceGenerationCurrent(deviceId, generation)) return;
          connect();
        }, RE_CONNECT_DELAY_MS);
      },
    });

    deviceProcesses.set(deviceId, {
      child,
      startedAt: Date.now(),
      status: "connecting",
      generation,
    });
  };

  connect();
};

const getLadderDeviceIds = async () => {
  const rows = await db.query(
    `
      SELECT DISTINCT (ls.system_config->'ladder_device'->>'device_id')::int AS id
      FROM location_systems ls
      WHERE ls.system_type = 'elevator'
        AND ls.system_config ? 'ladder_device'
        AND (ls.system_config->'ladder_device'->>'device_id') ~ '^[0-9]+$'
    `,
    [],
  );

  return (rows || [])
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n) && n > 0);
};

const start = async () => {
  const ids = await getLadderDeviceIds();
  logger.debug("啟動梯控 SDK 佈防", { count: ids.length });
  await Promise.all(ids.map((id) => startDeviceLoop(id)));
  return { started: true, deviceIds: ids };
};

/** 依 DB 梯控設備清單增刪佈防，不重啟未變更的設備 */
const reconcile = async () => {
  const desired = await getLadderDeviceIds();
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
    logger.info("梯控佈防刷新完成", {
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

const refresh = async () => {
  stop();
  await new Promise((resolve) => setTimeout(resolve, REFRESH_SETTLE_MS));
  return start();
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
  refresh,
  reconcile,
  getStatus,
  startDeviceLoop,
  stopDevice,
  getLadderDeviceIds,
};
