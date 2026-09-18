const logger = require("../../utils/logger");
const { mapWithConcurrency } = require("../../utils/mapWithConcurrency");
const runtimeConfigService = require("../platform/runtimeConfigService");
const { xmlDoc, escapeXml } = require("./isapiXmlUtils");
const {
  formatIsapiLocalTime,
  toIsapiTimeZone,
} = require("./isapiTimeFormat");
const {
  hasIsapiCredentials,
  listIsapiCapableDevices,
  resolveIsapiClientFromConfig,
} = require("./isapiDeviceUtils");

const syncLogger = logger.createLogger("ISAPI TimeSync");

const ISAPI_TIME_PATH = "/ISAPI/System/time";
const SYNC_CONCURRENCY = 8;
/** NAT 重連勿每次 PUT；與每日 03:00 排程並存 */
const CONNECT_SYNC_COOLDOWN_MS = 15 * 60 * 1000;

/** @type {Map<string, number>} */
const lastConnectSyncAt = new Map();

function getSyncTimezone() {
  return runtimeConfigService.getIsapiTimeSync().timezone;
}

function buildTimeSyncXml({ localTime, timeZone }) {
  return xmlDoc(
    "Time",
    `  <timeMode>manual</timeMode>
  <localTime>${escapeXml(localTime)}</localTime>
  <timeZone>${escapeXml(timeZone)}</timeZone>`,
  );
}

function buildTimeSyncPayload(now = new Date()) {
  const timezone = getSyncTimezone();
  return {
    localTime: formatIsapiLocalTime(now, timezone),
    timeZone: toIsapiTimeZone(timezone),
  };
}

async function syncDeviceConfig(config, meta = {}) {
  const { client } = resolveIsapiClientFromConfig(config, meta.label || "設備");
  const payload = buildTimeSyncPayload();
  const body = buildTimeSyncXml(payload);
  await client.request({
    method: "PUT",
    path: ISAPI_TIME_PATH,
    data: body,
    headers: { "Content-Type": 'application/xml; charset="UTF-8"' },
  });
  return {
    ok: true,
    deviceId: meta.deviceId ?? null,
    deviceName: meta.deviceName ?? config?.host,
    localTime: payload.localTime,
    timeZone: payload.timeZone,
  };
}

function deviceLabel(typeCode) {
  return typeCode === "camera" ? "攝影機" : "門禁";
}

function resolveDeviceId(raw) {
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function syncDeviceTime(deviceRow) {
  return syncDeviceConfig(deviceRow?.config, {
    label: deviceLabel(deviceRow?.type_code),
    deviceId: resolveDeviceId(deviceRow?.id),
    deviceName: deviceRow?.name,
  });
}

/**
 * 佈防訂閱前是否應立刻校時（停用、缺帳密／id、cooldown 則略過）。
 */
function shouldAttemptConnectSync({
  enabled,
  hasCredentials,
  deviceId,
  lastAt,
  now,
  cooldownMs = CONNECT_SYNC_COOLDOWN_MS,
} = {}) {
  if (enabled === false) return { attempt: false, reason: "disabled" };
  if (!hasCredentials || deviceId == null) {
    return { attempt: false, reason: "incomplete" };
  }
  if (lastAt != null && now - lastAt < cooldownMs) {
    return { attempt: false, reason: "cooldown" };
  }
  return { attempt: true };
}

/**
 * 佈防訂閱建立前校時。失敗只記 log，不擋訂閱；cooldown 避免 NAT 重連打爆設備。
 */
async function syncOnConnect(device) {
  const config = device?.config;
  const deviceId = resolveDeviceId(device?.id);
  const key = deviceId != null ? `id:${deviceId}` : "";
  const decision = shouldAttemptConnectSync({
    enabled: runtimeConfigService.getIsapiTimeSync().enabled,
    hasCredentials: hasIsapiCredentials(config),
    deviceId,
    lastAt: key ? lastConnectSyncAt.get(key) : undefined,
    now: Date.now(),
  });
  if (!decision.attempt) return;

  lastConnectSyncAt.set(key, Date.now());
  try {
    const r = await syncDeviceConfig(config, {
      label: deviceLabel(device?.type_code),
      deviceId,
      deviceName: device?.name,
    });
    syncLogger.info("連線校時成功", {
      deviceId: r.deviceId,
      deviceName: r.deviceName,
    });
  } catch (e) {
    syncLogger.warn("連線校時失敗", {
      deviceId,
      deviceName: device?.name,
      error: e?.message || String(e),
    });
  }
}

async function syncAllIsapiDevices() {
  const devices = await listIsapiCapableDevices();
  if (!devices.length) {
    syncLogger.info("無 ISAPI 設備可校時");
    return { total: 0, success: 0, failed: 0, results: [] };
  }

  const results = await mapWithConcurrency(
    devices,
    async (row) => {
      try {
        const r = await syncDeviceTime(row);
        syncLogger.info("設備校時成功", {
          deviceId: r.deviceId,
          deviceName: r.deviceName,
        });
        return r;
      } catch (e) {
        syncLogger.warn("設備校時失敗", {
          deviceId: row?.id,
          deviceName: row?.name,
          error: e?.message || String(e),
        });
        return {
          ok: false,
          deviceId: Number(row?.id),
          deviceName: row?.name,
          error: e?.message || String(e),
        };
      }
    },
    { concurrency: SYNC_CONCURRENCY },
  );

  const success = results.filter((r) => r?.ok).length;
  const failed = results.length - success;
  syncLogger.info("ISAPI 設備校時完成", {
    total: results.length,
    success,
    failed,
  });
  return { total: results.length, success, failed, results };
}

module.exports = {
  CONNECT_SYNC_COOLDOWN_MS,
  buildTimeSyncXml,
  buildTimeSyncPayload,
  shouldAttemptConnectSync,
  syncDeviceConfig,
  syncDeviceTime,
  syncOnConnect,
  syncAllIsapiDevices,
};
