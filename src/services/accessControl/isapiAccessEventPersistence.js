/**
 * 門禁 ISAPI 事件落地（寫入 isapi_access_events、附圖、營運事件／WS）
 * 供訂閱串流與 backfill 共用；與 isapiSubscribeService 分離以避免循環依賴。
 */
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("ISAPI Subscribe");
const { writeIsapiUploadPicture } = require("../../utils/isapiUploadPicture");
const operationalEventService = require("../operationalEvents/operationalEventService");
const {
  summaryAccessEvent,
} = require("../operationalEvents/operationalEventCopy");
const {
  loadPlaceContextByAccessDeviceId,
} = require("../operationalEvents/operationalEventPlaceContext");
const {
  resolveOperationalAccessSemantics,
  resolveVerifyMethodKey,
  resolveOperationalAccessResult,
  extractSubEventType,
  extractAccessEventIdentity,
  shouldQueueAccessEventPicture,
} = require("../peopleCounting/accessControlLogLabels");
const {
  emitAccessControlEventFromPlaceContext,
} = require("../peopleCounting/accessEventCameraResolver");

/** 人臉辨識成功/失敗、酒精檢測正常/飲酒/醉酒 等 */
const SUB_TYPES_PROCESS = new Set([1, 9, 38, 39, 75, 76, 2077, 2078, 2079]);

/**
 * 是否為要寫入 DB 的門禁事件（major=5 且 sub 為上述種類）
 * @param {object} ac - AccessControllerEvent 巢狀物件
 */
function isProcessableEvent(ac) {
  if (!ac || Number(ac.majorEventType) !== 5) return false;
  return SUB_TYPES_PROCESS.has(Number(ac.subEventType));
}

/**
 * 寫入一筆門禁事件（附圖由訂閱串流依「先 JSON 後圖」以 attachPictureToEvent 補上）
 * @returns {Promise<{ inserted: boolean, id?: number }>}
 */
async function persistIsapiEvent(options) {
  const {
    deviceId = null,
    deviceIp = "",
    eventTime,
    eventType = "AccessControllerEvent",
    payload,
  } = options;

  if (!isProcessableEvent(payload)) return { inserted: false };

  const rows = await db.query(
    `INSERT INTO isapi_access_events (device_id, device_ip, event_time, event_type, payload, file_count, picture_path)
     VALUES (?, ?, ?, ?, ?, 0, NULL) RETURNING id`,
    [
      deviceId != null &&
      Number.isFinite(Number(deviceId)) &&
      Number(deviceId) > 0
        ? Number(deviceId)
        : null,
      deviceIp,
      eventTime || new Date().toISOString(),
      eventType,
      JSON.stringify(payload || {}),
    ],
  );
  const id = rows?.[0]?.id ?? null;
  const placeCtx = deviceId
    ? await loadPlaceContextByAccessDeviceId(deviceId)
    : { placeLabel: null, locationId: null, systemId: null, deviceRole: null };
  emitAccessControlEventFromPlaceContext(placeCtx, {
    source: "isapi",
    deviceId: deviceId || null,
    isapiPayload: payload,
  });
  if (id != null) {
    const ac = payload || {};
    const { personName, employeeNo, cardNo } = extractAccessEventIdentity(ac);
    const subEventType = extractSubEventType(ac) ?? ac.subEventType;
    const action = resolveOperationalAccessSemantics(ac, {
      deviceRole: placeCtx.deviceRole,
    });
    void operationalEventService.recordEvent({
      source: "people_counting",
      event_kind: "access",
      created_at: eventTime || new Date().toISOString(),
      location_id: placeCtx.locationId,
      system_id: placeCtx.systemId,
      device_id: deviceId || null,
      message: summaryAccessEvent({
        personName,
        employeeNo,
        placeLabel: placeCtx.placeLabel,
        action,
      }),
      ref_table: "isapi_access_events",
      ref_id: id,
      payload: {
        accessKind: "door",
        deviceIp,
        deviceId: deviceId || null,
        eventType,
        majorEventType: ac.majorEventType,
        subEventType,
        deviceRole: placeCtx.deviceRole,
        personName,
        employeeNo,
        cardNo,
        verifyMethod: resolveVerifyMethodKey(ac),
        result: resolveOperationalAccessResult(ac),
      },
    });
  }
  return { inserted: true, id };
}

/**
 * 為剛寫入的門禁事件補上附圖（僅人臉列；已有圖則略過）。
 * 主事件寫入時已推 WS；此處只落庫，不再二次 emit。
 */
async function attachPictureToEvent(eventId, pictureBuffer) {
  if (
    eventId == null ||
    !Buffer.isBuffer(pictureBuffer) ||
    pictureBuffer.length === 0
  )
    return;
  const rows = await db.query(
    `SELECT device_ip, event_time, payload, picture_path
     FROM isapi_access_events WHERE id = ?`,
    [eventId],
  );
  const row = rows?.[0];
  if (!row) return;
  const payload =
    row.payload != null && typeof row.payload === "object" ? row.payload : {};
  const hasPicture =
    row.picture_path != null && String(row.picture_path).trim() !== "";
  if (hasPicture || !shouldQueueAccessEventPicture(payload)) {
    logger.warn("[ISAPI] 拒絕附圖綁定（事件類型不符或已有圖）", {
      eventId,
      subEventType: payload.subEventType,
      hasPicture,
    });
    return;
  }
  const saved = writeIsapiUploadPicture({
    subdir: "access-events",
    deviceKey: row.device_ip,
    eventTime: row.event_time,
    recordId: eventId,
    pictureBuffer,
  });
  if (!saved) return;
  await db.query(
    `UPDATE isapi_access_events SET picture_path = ?, file_count = 1 WHERE id = ?`,
    [saved.picturePath, eventId],
  );
}

module.exports = {
  isProcessableEvent,
  persistIsapiEvent,
  attachPictureToEvent,
};
