/**
 * 梯控 SDK 佈防常駐服務
 * 過濾事件後推送 WebSocket：ladder_sdk:event
 */
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("Ladder SDK Arming");
const { spawnArmingProcess } = require("./sdkBridgeClient");
const { resolveSdkCredentials } = require("./sdkLadderDeviceService");
const { persistLadderSdkEvent } = require("./sdkEventPersistence");
const deviceService = require("../devices/deviceService");

const RE_CONNECT_DELAY_MS = 10_000;

/** @type {Map<number, { child: import('child_process').ChildProcess, startedAt: number, status: string }>} */
const deviceProcesses = new Map();

const enrichEvent = (deviceId, device, message) => ({
  deviceId,
  deviceName: device?.name || "",
  major: message.major,
  minor: message.minor,
  eventName: message.eventName,
  floor: message.floor ?? null,
  cardNo: message.cardNo ?? null,
  timestamp: message.timestamp || new Date().toISOString(),
});

const handleEvent = async (deviceId, device, message) => {
  const enriched = enrichEvent(deviceId, device, message);
  try {
    await persistLadderSdkEvent({
      deviceId,
      deviceIp: device?.config?.host || "",
      eventTime: enriched.timestamp,
      major: enriched.major,
      minor: enriched.minor,
      eventName: enriched.eventName,
      floor: enriched.floor,
      cardNo: enriched.cardNo,
      payload: enriched,
    });
  } catch (error) {
    logger.warn("梯控事件寫入失敗", {
      deviceId,
      error: error?.message || String(error),
    });
  }
};

const stopDevice = (deviceId) => {
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
    if (deviceProcesses.has(deviceId)) {
      return;
    }

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
        logger.warn("梯控佈防程序結束，將重連", { deviceId, code });
        setTimeout(connect, RE_CONNECT_DELAY_MS);
      },
    });

    deviceProcesses.set(deviceId, {
      child,
      startedAt: Date.now(),
      status: "connecting",
    });
  };

  connect();
};

const getLadderDeviceIds = async () => {
  const rows = await db.query(
    `
      SELECT id
      FROM devices
      WHERE type_code = 'controller'
        AND config->>'protocol' = 'hcnet_sdk'
      UNION
      SELECT id
      FROM devices
      WHERE type_code = 'access_control'
        AND (
          (config->>'sdk_port') IS NOT NULL
          OR (config->>'sdkPort') IS NOT NULL
        )
    `,
    [],
  );

  return (rows || [])
    .map((row) => parseInt(String(row.id), 10))
    .filter((id) => Number.isFinite(id));
};

const start = async () => {
  const ids = await getLadderDeviceIds();
  logger.info("啟動梯控 SDK 佈防", { count: ids.length });
  await Promise.all(ids.map((id) => startDeviceLoop(id)));
  return { started: true, deviceIds: ids };
};

const stop = () => {
  for (const deviceId of deviceProcesses.keys()) {
    stopDevice(deviceId);
  }
};

const refresh = async () => {
  stop();
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
  getStatus,
  startDeviceLoop,
  stopDevice,
  getLadderDeviceIds,
};
