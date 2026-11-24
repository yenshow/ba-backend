/**
 * 車牌 ANPR 事件補齊：訂閱／heartbeat 後以協議時間窗短查 Traffic vehicleDetect；
 * 去重鍵＝device_id + location_id + deviceEventId（matchNo／UUID／車牌圖 path）。
 */
const logger = require("../../utils/logger").createLogger(
  "ISAPI Vehicle Catchup",
);
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const {
  parseVehicleSearchResult,
} = require("./isapiVehicleXmlParser");
const {
  persistAnprEvent,
  attachLicensePlatePicture,
  findExistingVehicleLogByDeviceEventId,
} = require("./isapiVehiclePersistence");
const {
  createDebouncedScheduler,
  downloadIsapiPicture,
  formatIsapiLocalDateTime,
  responseBodyToString,
  DEFAULT_DEBOUNCE_MS,
  PROTOCOL_LOOKBACK_SEC,
} = require("../isapi/isapiEventBackfillCommon");
const { escapeXml } = require("../isapi/isapiXmlUtils");

const PAGE_SIZE = 30;
const MAX_PAGES = 5;
const SEARCH_PATHS = (channelId) => [
  `/ISAPI/Traffic/channels/${channelId}/vehicleDetectResult/search`,
  `/ISAPI/Traffic/channels/${channelId}/vehicleDetect/search`,
];
const scheduler = createDebouncedScheduler(DEFAULT_DEBOUNCE_MS);

/** @type {Map<number, number>} deviceId → lastCatchupAt ms */
const lastCatchupAt = new Map();

function resolveProtocolTimeRange(eventTime) {
  const endMs = Date.now();
  const end = new Date(endMs);
  let startMs = endMs - PROTOCOL_LOOKBACK_SEC * 1000;
  if (eventTime != null) {
    const center = new Date(eventTime).getTime();
    if (Number.isFinite(center)) {
      startMs = Math.min(startMs, center - PROTOCOL_LOOKBACK_SEC * 1000);
    }
  }
  return { start: new Date(startMs), end };
}

function buildSearchXml({ searchId, position, start, end }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription version="2.0" xmlns="http://www.std-cgi.com/ver20/XMLSchema">
  <searchID>${escapeXml(searchId)}</searchID>
  <searchResultPosition>${Math.max(0, position)}</searchResultPosition>
  <maxResults>${PAGE_SIZE}</maxResults>
  <timeSpanList>
    <timeSpan>
      <startTime>${escapeXml(formatIsapiLocalDateTime(start))}</startTime>
      <endTime>${escapeXml(formatIsapiLocalDateTime(end))}</endTime>
    </timeSpan>
  </timeSpanList>
</CMSearchDescription>`;
}

async function fetchVehicleSearchMatches(client, channelId, start, end) {
  const searchId = `ba-anpr-${Date.now()}`;
  let lastErr = null;
  for (const path of SEARCH_PATHS(channelId)) {
    try {
      const all = [];
      let position = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const res = await client.request({
          method: "POST",
          path,
          data: buildSearchXml({ searchId, position, start, end }),
          headers: { "Content-Type": "application/xml" },
        });
        const parsed = parseVehicleSearchResult(responseBodyToString(res.data));
        all.push(...parsed.rows);
        const status = parsed.status;
        if (
          parsed.rows.length === 0 ||
          status === "OK" ||
          status === "NO MATCH" ||
          status === "NO MATCHES"
        ) {
          break;
        }
        position += parsed.rows.length;
      }
      return all;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

/**
 * @param {{
 *   deviceId: number,
 *   locationTargets: Array<{ locationId: number, locationName?: string, zoneName?: string, laneType: number }>,
 *   channelId?: number,
 *   eventTime?: string|Date|null,
 * }} options
 */
async function runCatchup(options) {
  const deviceId = Number(options?.deviceId);
  const locationTargets = Array.isArray(options?.locationTargets)
    ? options.locationTargets
    : [];
  if (!Number.isFinite(deviceId) || deviceId <= 0 || locationTargets.length === 0) {
    return { matched: 0, inserted: 0 };
  }

  const prevAt = lastCatchupAt.get(deviceId);
  let { start, end } = resolveProtocolTimeRange(options?.eventTime);
  if (prevAt != null && Number.isFinite(prevAt)) {
    const floor = Math.max(start.getTime(), prevAt);
    if (floor < end.getTime()) start = new Date(floor);
  }

  const { device } = await deviceService.getDeviceById(deviceId);
  if (!device?.config?.host) {
    throw new Error("攝影機連線設定不完整");
  }
  const client = createIsapiClient(device.config, {
    typeCode: device.type_code,
  });
  const channelId = Number(options?.channelId) > 0 ? Number(options.channelId) : 1;
  const rows = await fetchVehicleSearchMatches(client, channelId, start, end);
  let inserted = 0;
  let skippedNoId = 0;

  for (const row of rows) {
    if (!row.deviceEventId) {
      skippedNoId += 1;
      continue;
    }
    const parsed = {
      dateTime: row.dateTime,
      eventType: "ANPR",
      licensePlate: row.licensePlate,
      listType: row.listType,
      deviceEventId: row.deviceEventId,
      picturePath: row.picturePath,
    };

    // 各地點先查缺圖，再一次 fan-out persist
    const missingPicIds = [];
    let allExist = true;
    for (const target of locationTargets) {
      const existing = await findExistingVehicleLogByDeviceEventId(
        deviceId,
        target.locationId,
        row.deviceEventId,
      );
      if (existing.id == null) {
        allExist = false;
      } else if (!existing.hasPicture) {
        missingPicIds.push(existing.id);
      }
    }

    if (allExist) {
      if (missingPicIds.length > 0 && row.picturePath) {
        const pic = await downloadIsapiPicture(client, row.picturePath);
        if (pic) await attachLicensePlatePicture(missingPicIds, pic);
      }
      continue;
    }

    const res = await persistAnprEvent({
      parsed,
      deviceId,
      locationTargets,
      source: "catchup",
    });
    if (res.inserted) {
      inserted += res.ids.length;
      if (row.picturePath) {
        const pic = await downloadIsapiPicture(client, row.picturePath);
        const attachIds = [...res.ids, ...res.existingIds];
        if (pic && attachIds.length > 0) {
          await attachLicensePlatePicture(attachIds, pic);
        }
      }
    } else if (res.existingIds?.length && row.picturePath) {
      const pic = await downloadIsapiPicture(client, row.picturePath);
      if (pic) await attachLicensePlatePicture(res.existingIds, pic);
    }
  }

  lastCatchupAt.set(deviceId, end.getTime());

  if (inserted > 0 || skippedNoId > 0) {
    logger.info("車牌事件 catch-up 完成", {
      deviceId,
      matched: rows.length,
      inserted,
      skippedNoId,
    });
  }
  if (skippedNoId > 0) {
    logger.warn("車牌 Traffic search 列缺少 deviceEventId，已略過", {
      deviceId,
      skippedNoId,
    });
  }
  return { matched: rows.length, inserted, skippedNoId };
}

/**
 * @param {{
 *   deviceId: number,
 *   locationTargets: Array<{ locationId: number, locationName?: string, zoneName?: string, laneType: number }>,
 *   channelId?: number,
 *   eventTime?: string|Date|null,
 * }} options
 */
function scheduleVehicleEventCatchup(options) {
  const deviceId = Number(options?.deviceId);
  if (!Number.isFinite(deviceId) || deviceId <= 0) return;
  if (
    !Array.isArray(options?.locationTargets) ||
    options.locationTargets.length === 0
  ) {
    return;
  }
  const key = `vehicle-catchup:${deviceId}`;
  scheduler.schedule(key, () =>
    runCatchup(options).catch((e) => {
      logger.warn("車牌事件補齊失敗", {
        deviceId,
        error: e?.message || String(e),
      });
    }),
  );
}

module.exports = {
  scheduleVehicleEventCatchup,
  runCatchup,
};
