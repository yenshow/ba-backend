const logger = require("../../utils/logger");
const { mapWithConcurrency } = require("../../utils/mapWithConcurrency");
const runtimeConfigService = require("../platform/runtimeConfigService");
const { xmlDoc, escapeXml } = require("./isapiXmlUtils");
const {
  formatIsapiLocalTime,
  toIsapiTimeZone,
} = require("./isapiTimeFormat");
const {
  listIsapiCapableDevices,
  resolveIsapiClientFromConfig,
} = require("./isapiDeviceUtils");

const syncLogger = logger.createLogger("ISAPI TimeSync");

const ISAPI_TIME_PATH = "/ISAPI/System/time";
const SYNC_CONCURRENCY = 8;

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

async function syncDeviceTime(deviceRow) {
  const label =
    deviceRow?.type_code === "camera" ? "攝影機" : "門禁";
  return syncDeviceConfig(deviceRow?.config, {
    label,
    deviceId: Number(deviceRow?.id),
    deviceName: deviceRow?.name,
  });
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
  buildTimeSyncXml,
  buildTimeSyncPayload,
  syncDeviceConfig,
  syncDeviceTime,
  syncAllIsapiDevices,
};
