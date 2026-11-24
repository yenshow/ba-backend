/**
 * 門禁事件補齊：訂閱／heartbeat 觸發後，依 serialNo 水位短查 AcsEvent。
 * 去重鍵＝device_id + serialNo；不以時間窗決定補哪些事件。
 * 對齊 SDK NET_DVR_ACS_EVENT_COND.dwBeginSerialNo／dwEndSerialNo。
 */
const logger = require("../../utils/logger").createLogger(
  "ISAPI Access Catchup",
);
const accessControlService = require("./accessControlService");
const {
  shouldQueueAccessEventPicture,
} = require("../peopleCounting/accessControlLogLabels");
const {
  fetchAcsEvents,
  toAcsEventPayload,
  findExistingAccessEvent,
  getMaxStoredSerialNo,
  parseSerialNo,
} = require("./isapiAcsEventQuery");
const {
  createDebouncedScheduler,
  downloadIsapiPicture,
  formatIsapiLocalDateTime,
  DEFAULT_DEBOUNCE_MS,
} = require("../isapi/isapiEventBackfillCommon");
const {
  persistIsapiEvent,
  isProcessableEvent,
  attachPictureToEvent,
} = require("./isapiAccessEventPersistence");

const PAGE_SIZE = 30;
const MAX_PAGES = 10;
const MAX_CATCHUP_SPAN = PAGE_SIZE * MAX_PAGES;
const scheduler = createDebouncedScheduler(DEFAULT_DEBOUNCE_MS);

/** @type {Map<number, number>} 程序內水位快取（DB 為 SSOT） */
const serialWatermark = new Map();

/** @type {Map<number, number>} debounce 期間累積的最大 hint */
const pendingHintSerial = new Map();

function noteSerialSeen(deviceId, serial) {
  const id = Number(deviceId);
  const s = parseSerialNo(serial);
  if (!Number.isFinite(id) || id <= 0 || s == null) return;
  const prev = serialWatermark.get(id);
  if (prev == null || s > prev) serialWatermark.set(id, s);
}

async function resolveWatermark(deviceId) {
  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (serialWatermark.has(id)) return serialWatermark.get(id) ?? null;
  const fromDb = await getMaxStoredSerialNo(id);
  if (fromDb != null) serialWatermark.set(id, fromDb);
  return fromDb;
}

/**
 * 協議佔位時間：僅在實機拒絕「純序號」Cond 時補送，不用來篩選／去重。
 */
function protocolPlaceholderTimes() {
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
  return {
    startTime: formatIsapiLocalDateTime(start),
    endTime: formatIsapiLocalDateTime(end),
  };
}

async function fetchBySerial(client, { beginSerialNo, endSerialNo }) {
  const base = {
    beginSerialNo,
    endSerialNo,
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
  };
  try {
    return await fetchAcsEvents(client, base);
  } catch (error) {
    const placeholder = protocolPlaceholderTimes();
    logger.warn("AcsEvent 序號查詢失敗，改送協議佔位時間重試", {
      beginSerialNo,
      endSerialNo,
      error: error?.message || String(error),
    });
    return fetchAcsEvents(client, {
      ...base,
      startTime: placeholder.startTime,
      endTime: placeholder.endTime,
    });
  }
}

async function maybeAttachPicture(client, eventId, payload) {
  if (
    eventId == null ||
    !shouldQueueAccessEventPicture(payload) ||
    !payload.pictureURL
  ) {
    return;
  }
  const pic = await downloadIsapiPicture(client, payload.pictureURL);
  if (pic) await attachPictureToEvent(eventId, pic);
}

/**
 * @param {{ deviceId: number, deviceIp?: string, hintSerialNo?: number|null }} options
 */
async function runCatchup(options) {
  const deviceId = Number(options?.deviceId);
  if (!Number.isFinite(deviceId) || deviceId <= 0) {
    return { matched: 0, inserted: 0 };
  }
  const hintSerialNo = parseSerialNo(options?.hintSerialNo);
  let last = await resolveWatermark(deviceId);

  if (hintSerialNo != null && last != null && hintSerialNo < last) {
    logger.warn("門禁 serialNo 回繞或重置，調整補齊起點", {
      deviceId,
      lastSerialNo: last,
      hintSerialNo,
    });
    serialWatermark.set(deviceId, hintSerialNo);
    last = hintSerialNo;
  }

  /**
   * 有 hint（訂閱驗證事件）：回掃 hint 前一段，補齊漏推（當前事件可能已寫入抬高水位）。
   * 無 hint（heartbeat）：從水位 +1 往後撈。
   */
  let beginSerialNo;
  let endSerialNo;
  if (hintSerialNo != null) {
    beginSerialNo = Math.max(0, hintSerialNo - MAX_CATCHUP_SPAN + 1);
    endSerialNo = hintSerialNo;
  } else if (last != null) {
    beginSerialNo = last + 1;
    endSerialNo = beginSerialNo + MAX_CATCHUP_SPAN - 1;
  } else {
    beginSerialNo = 0;
    endSerialNo = MAX_CATCHUP_SPAN - 1;
  }

  const { client } = await accessControlService.getDeviceAndClient(deviceId);
  const items = await fetchBySerial(client, { beginSerialNo, endSerialNo });
  let inserted = 0;
  for (const item of items) {
    const payload = toAcsEventPayload(item);
    if (!isProcessableEvent(payload)) continue;
    const serial = parseSerialNo(payload.serialNo);
    if (serial == null) continue;
    if (serial < beginSerialNo) continue;
    if (hintSerialNo != null && serial > hintSerialNo) continue;

    const eventTimeIso =
      item.time != null
        ? String(item.time)
        : item.dateTime != null
          ? String(item.dateTime)
          : new Date().toISOString();
    const existing = await findExistingAccessEvent(deviceId, payload);
    noteSerialSeen(deviceId, serial);
    if (existing.id != null) {
      if (!existing.hasPicture) {
        await maybeAttachPicture(client, existing.id, payload);
      }
      continue;
    }
    const result = await persistIsapiEvent({
      deviceId,
      deviceIp: options.deviceIp || "",
      eventTime: eventTimeIso,
      eventType: "AccessControllerEvent",
      payload: { ...payload, catchup: true },
    });
    if (result?.inserted && result.id != null) {
      inserted += 1;
      await maybeAttachPicture(client, result.id, payload);
    }
  }

  if (hintSerialNo != null) noteSerialSeen(deviceId, hintSerialNo);

  if (inserted > 0) {
    logger.info("門禁事件 serialNo 補齊完成", {
      deviceId,
      beginSerialNo,
      endSerialNo,
      matched: items.length,
      inserted,
    });
  }
  return { matched: items.length, inserted };
}

/**
 * 訂閱驗證事件或 heartbeat 觸發；debounce 合併同設備多次觸發。
 * 多次驗證事件合併時保留較大的 hintSerialNo。
 * @param {{ deviceId: number, deviceIp?: string, hintSerialNo?: number|null }} options
 */
function scheduleAccessEventCatchup(options) {
  const deviceId = Number(options?.deviceId);
  if (!Number.isFinite(deviceId) || deviceId <= 0) return;
  const hintSerialNo = parseSerialNo(options?.hintSerialNo);
  if (hintSerialNo != null) {
    const prev = pendingHintSerial.get(deviceId);
    if (prev == null || hintSerialNo > prev) {
      pendingHintSerial.set(deviceId, hintSerialNo);
    }
  }

  const deviceIp = options?.deviceIp;
  scheduler.schedule(`access-catchup:${deviceId}`, () => {
    const hint = pendingHintSerial.has(deviceId)
      ? pendingHintSerial.get(deviceId)
      : null;
    pendingHintSerial.delete(deviceId);
    return runCatchup({
      deviceId,
      deviceIp,
      hintSerialNo: hint,
    }).catch((e) => {
      logger.warn("門禁事件補齊失敗", {
        deviceId,
        error: e?.message || String(e),
      });
    });
  });
}

module.exports = {
  scheduleAccessEventCatchup,
  noteSerialSeen,
};
