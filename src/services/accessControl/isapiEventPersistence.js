/**
 * 門禁 ISAPI 事件寫入（佈防訂閱使用，先 JSON 後圖）
 * 寫入 isapi_access_events；附圖由 attachPictureToEvent 寫入 uploads/access-events
 */
const path = require("path");
const fs = require("fs");
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const { formatUploadTimestampForFilename } = require("../../utils/baDataPaths");
const operationalEventService = require("../operationalEvents/operationalEventService");
const { summaryAccessEvent } = require("../operationalEvents/operationalEventCopy");

const SUB_TYPES_PROCESS = new Set([1, 9, 38, 39, 75, 76, 2077, 2078, 2079]); // 人臉辨識成功/失敗、酒精檢測正常/飲酒/醉酒

/**
 * 是否為要寫入 DB 的門禁事件（major=5 且 sub 為上述五種）
 * @param {object} ac - AccessControllerEvent 巢狀物件（含 majorEventType、subEventType）
 */
function isProcessableEvent(ac) {
  if (!ac || Number(ac.majorEventType) !== 5) return false;
  return SUB_TYPES_PROCESS.has(Number(ac.subEventType));
}

/**
 * 寫入一筆門禁事件（附圖由訂閱串流依「先 JSON 後圖」以 attachPictureToEvent 補上）
 * @param {object} options - deviceIp, eventTime, eventType, payload
 * @returns {Promise<{ inserted: boolean, id?: number }>} - id 供下一 part 補圖
 */
async function persistIsapiEvent(options) {
  const {
    deviceIp = "",
    eventTime,
    eventType = "AccessControllerEvent",
    payload,
  } = options;

  if (!isProcessableEvent(payload)) return { inserted: false };

  const rows = await db.query(
    `INSERT INTO isapi_access_events (device_ip, event_time, event_type, payload, file_count, picture_path)
     VALUES (?, ?, ?, ?, 0, NULL) RETURNING id`,
    [
      deviceIp,
      eventTime || new Date().toISOString(),
      eventType,
      JSON.stringify(payload || {}),
    ],
  );
  const id = rows?.[0]?.id ?? null;
  websocketService.emitIsapiAccessEvent();
  if (id != null) {
    const ac = payload || {};
    const personName =
      ac.name || ac.employeeNoString || ac.cardNo || deviceIp || "";
    void operationalEventService.recordEvent({
      source: "people_counting",
      event_kind: "access",
      occurred_at: eventTime || new Date().toISOString(),
      summary: summaryAccessEvent({
        eventType,
        personName,
      }),
      ref_table: "isapi_access_events",
      ref_id: id,
      payload: {
        deviceIp,
        eventType,
        majorEventType: ac.majorEventType,
        subEventType: ac.subEventType,
      },
    });
  }
  return { inserted: true, id };
}

/**
 * 為剛寫入的門禁事件補上附圖（multipart 順序：先 JSON 後圖）
 * 檔名與原監聽模式一致：設備IP_時間.jpg（如 192.168.2.34_2026-03-02T17-43.jpg）
 */
async function attachPictureToEvent(eventId, pictureBuffer, uploadsDir) {
  if (
    eventId == null ||
    !Buffer.isBuffer(pictureBuffer) ||
    pictureBuffer.length === 0 ||
    !uploadsDir
  )
    return;
  const rows = await db.query(
    `SELECT device_ip, event_time FROM isapi_access_events WHERE id = ?`,
    [eventId],
  );
  const row = rows?.[0];
  if (!row) return;
  const deviceIp = row.device_ip || "unknown";
  const eventTime = row.event_time || new Date().toISOString();
  const safeIp = String(deviceIp).replace(/[^0-9a-fA-F.:]/g, "_");
  const rawTime = formatUploadTimestampForFilename(eventTime, 16);
  const basename = `${safeIp}_${rawTime}.jpg`;
  const filePath = path.join(uploadsDir, basename);
  fs.writeFileSync(filePath, pictureBuffer);
  const picturePath = `/uploads/access-events/${basename}`;
  await db.query(
    `UPDATE isapi_access_events SET picture_path = ?, file_count = 1 WHERE id = ?`,
    [picturePath, eventId],
  );
  websocketService.emitIsapiAccessEvent();
}

module.exports = {
  isProcessableEvent,
  persistIsapiEvent,
  attachPictureToEvent,
};
