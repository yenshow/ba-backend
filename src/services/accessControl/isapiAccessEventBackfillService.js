/**
 * 門禁事件補齊：訂閱寫入後以 AcsEvent（門禁 JSON API）短查近 N 秒並去重落地
 * 注意：與攝影機 FCSearch／車牌 Traffic search 為不同設備 API。
 */
const logger = require("../../utils/logger").createLogger(
  "ISAPI Access Backfill",
);
const db = require("../../database/db");
const accessControlService = require("./accessControlService");
const {
  shouldQueueAccessEventPicture,
} = require("../peopleCounting/accessControlLogLabels");
const {
  fetchAcsEvents,
  toAcsEventPayload,
  findExistingAccessEvent,
} = require("./isapiAcsEventQuery");
const {
  resolveBackfillTimeRange,
  formatIsapiLocalDateTime,
  createDebouncedScheduler,
  normalizeEventBackfillWindowSec,
  downloadIsapiPicture,
  mergeEventBackfillPrefs,
} = require("../isapi/isapiEventBackfillCommon");

/** 延遲載入，避免與 isapiSubscribeService 循環依賴 */
const getSubscribePersistence = () => require("./isapiSubscribeService");

const PAGE_SIZE = 30;
const MAX_PAGES = 10;
const PREFS_CACHE_MS = 30_000;
const scheduler = createDebouncedScheduler();

/** @type {Map<number, { enabled: boolean, windowSec: number, expiresAt: number }>} */
const prefsCache = new Map();

/**
 * 讀取綁定此門禁設備的 people_counting 地點補齊設定（任一開啟即啟用；秒數取最大）
 */
async function resolveAccessBackfillForDevice(deviceId) {
  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) {
    return { enabled: false, windowSec: 5 };
  }
  const cached = prefsCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return { enabled: cached.enabled, windowSec: cached.windowSec };
  }
  const rows = await db.query(
    `SELECT system_config
     FROM location_systems
     WHERE system_type = 'people_counting'
       AND (
         EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
             COALESCE(system_config->'entry_device_ids', '[]'::jsonb)
           ) AS e(id)
           WHERE e.id::int = ?
         )
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
             COALESCE(system_config->'exit_device_ids', '[]'::jsonb)
           ) AS x(id)
           WHERE x.id::int = ?
         )
       )`,
    [id, id],
  );
  const prefs = mergeEventBackfillPrefs(
    (rows || []).map((r) => r.system_config || {}),
  );
  prefsCache.set(id, {
    ...prefs,
    expiresAt: Date.now() + PREFS_CACHE_MS,
  });
  return prefs;
}

async function runBackfill({ deviceId, eventTime, windowSec, deviceIp }) {
  const { start, end } = resolveBackfillTimeRange(eventTime, windowSec);
  const { client } = await accessControlService.getDeviceAndClient(deviceId);
  const items = await fetchAcsEvents(client, {
    startTime: formatIsapiLocalDateTime(start),
    endTime: formatIsapiLocalDateTime(end),
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
  });
  const {
    persistIsapiEvent,
    isProcessableEvent,
    attachPictureToEvent,
  } = getSubscribePersistence();
  let inserted = 0;
  for (const item of items) {
    const payload = toAcsEventPayload(item);
    if (!isProcessableEvent(payload)) continue;
    const eventTimeIso =
      item.time != null
        ? String(item.time)
        : item.dateTime != null
          ? String(item.dateTime)
          : new Date().toISOString();
    const existing = await findExistingAccessEvent(
      deviceId,
      eventTimeIso,
      payload,
    );
    if (existing.id != null) {
      if (
        !existing.hasPicture &&
        shouldQueueAccessEventPicture(payload) &&
        payload.pictureURL
      ) {
        const pic = await downloadIsapiPicture(client, payload.pictureURL);
        if (pic) await attachPictureToEvent(existing.id, pic);
      }
      continue;
    }
    const result = await persistIsapiEvent({
      deviceId,
      deviceIp: deviceIp || "",
      eventTime: eventTimeIso,
      eventType: "AccessControllerEvent",
      payload: { ...payload, backfill: true },
    });
    if (result?.inserted && result.id != null) {
      inserted += 1;
      if (shouldQueueAccessEventPicture(payload) && payload.pictureURL) {
        const pic = await downloadIsapiPicture(client, payload.pictureURL);
        if (pic) await attachPictureToEvent(result.id, pic);
      }
    }
  }
  logger.info("門禁事件補齊完成", {
    deviceId,
    windowSec: normalizeEventBackfillWindowSec(windowSec),
    matched: items.length,
    inserted,
  });
  return { matched: items.length, inserted };
}

function scheduleAccessEventBackfill(options) {
  const deviceId = Number(options?.deviceId);
  if (!Number.isFinite(deviceId) || deviceId <= 0) return;

  /** 先確認地點有開補齊再 debounce，避免未開時每筆事件仍排程 */
  void (async () => {
    const cfg =
      options.enabled != null
        ? {
            enabled: Boolean(options.enabled),
            windowSec: normalizeEventBackfillWindowSec(options.windowSec),
          }
        : await resolveAccessBackfillForDevice(deviceId);
    if (!cfg.enabled) return;
    scheduler.schedule(`access:${deviceId}`, () =>
      runBackfill({
        deviceId,
        eventTime: options.eventTime,
        windowSec: cfg.windowSec,
        deviceIp: options.deviceIp,
      }).catch((e) => {
        logger.warn("門禁事件補齊失敗", {
          deviceId,
          error: e?.message || String(e),
        });
      }),
    );
  })();
}

module.exports = {
  scheduleAccessEventBackfill,
  resolveAccessBackfillForDevice,
  runBackfill,
};
