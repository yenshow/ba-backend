/**
 * ISAPI 攝影機人臉比對（alarmResult）事件落地
 * 進出語意：由進場／出場攝影機設備歸屬決定（與門禁 entry/exit device 相同）
 * 附圖：multipart 先事件後圖，由訂閱端呼叫 attachPictureToFaceContrastEvent
 */
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const { writeIsapiUploadPicture } = require("../../utils/isapiUploadPicture");

function safeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 設備常不回 customHumanID：以姓名對齊平台人員工號（同名多筆不綁） */
async function resolveEmployeeNoByPersonName(personName) {
  const name = personName != null ? String(personName).trim() : "";
  if (!name) return null;
  const rows = await db.query(
    `SELECT employee_no FROM persons
     WHERE full_name = ? AND status = 'active'
     ORDER BY id ASC
     LIMIT 2`,
    [name],
  );
  if (!rows?.length || rows.length > 1) return null;
  const no = rows[0]?.employee_no;
  return no != null && String(no).trim() ? String(no).trim() : null;
}

/**
 * @param {object} options
 * @param {'entry'|'exit'|null|undefined} options.direction - 由訂閱端依設備歸屬傳入
 */
async function persistFaceContrastEvent(options) {
  const locationId = safeInt(options.locationId);
  const deviceId = safeInt(options.deviceId);
  if (!locationId || !deviceId) return null;

  const eventTimeRaw = options.eventTime;
  const eventTime = eventTimeRaw ? new Date(eventTimeRaw) : new Date();
  if (Number.isNaN(eventTime.getTime())) return null;

  const channelId = safeInt(options.channelId) || 1;
  const similarity = safeNum(options.similarity);
  let employeeNo =
    options.employeeNo != null ? String(options.employeeNo).trim() : null;
  const personName =
    options.personName != null ? String(options.personName).trim() : null;
  if (!employeeNo && personName) {
    employeeNo = await resolveEmployeeNoByPersonName(personName);
  }
  const pid = options.pid != null ? String(options.pid).trim() : null;
  const certificateNumber =
    options.certificateNumber != null
      ? String(options.certificateNumber).trim()
      : null;
  const matched =
    options.matched == null ? similarity != null : Boolean(options.matched);
  const eventType =
    options.eventType != null
      ? String(options.eventType).trim()
      : "alarmResult";
  const deviceIp =
    options.deviceIp != null ? String(options.deviceIp).trim() : null;
  const faceLibName =
    options.faceLibName != null ? String(options.faceLibName).trim() : null;

  const direction =
    options.direction === "entry" || options.direction === "exit"
      ? options.direction
      : null;

  const payload = {
    source: "subscribe",
    ...(direction ? { direction } : {}),
    ...(faceLibName ? { faceLibName } : {}),
    ...(pid ? { pid } : {}),
  };

  const rows = await db.query(
    `INSERT INTO isapi_face_contrast_events (
       location_id, device_id, device_ip, channel_id, event_time,
       event_type, similarity, employee_no, person_name, pid,
       certificate_number, matched, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
     RETURNING id, event_time`,
    [
      locationId,
      deviceId,
      deviceIp,
      channelId,
      eventTime.toISOString(),
      eventType,
      similarity,
      employeeNo,
      personName,
      pid,
      certificateNumber,
      matched,
      JSON.stringify(payload),
    ],
  );

  const id = rows?.[0]?.id != null ? Number(rows[0].id) : null;
  const storedAt = rows?.[0]?.event_time || eventTime.toISOString();

  const wsPayload = {
    locationId,
    deviceId,
    channelId,
    eventTime: storedAt,
    eventType,
    similarity,
    employeeNo,
    personName,
    pid,
    matched,
    direction,
    faceLibName,
    id,
  };
  try {
    websocketService.emitIsapiFaceContrastEvent(wsPayload);
  } catch (_e) {
    // WS 失敗不影響落地
  }

  return wsPayload;
}

/**
 * 為剛寫入的人臉比對事件補上附圖（multipart 順序：先 JSON／XML 後圖）
 */
async function attachPictureToFaceContrastEvent(eventId, pictureBuffer) {
  if (
    eventId == null ||
    !Buffer.isBuffer(pictureBuffer) ||
    pictureBuffer.length === 0
  ) {
    return null;
  }
  const rows = await db.query(
    `SELECT device_ip, event_time, picture_path
     FROM isapi_face_contrast_events WHERE id = ?`,
    [eventId],
  );
  const row = rows?.[0];
  if (!row) return null;
  if (row.picture_path) return row.picture_path;

  const saved = writeIsapiUploadPicture({
    subdir: "face-contrast-events",
    deviceKey: row.device_ip,
    eventTime: row.event_time,
    recordId: eventId,
    pictureBuffer,
  });
  if (!saved) return null;

  await db.query(
    `UPDATE isapi_face_contrast_events SET picture_path = ? WHERE id = ?`,
    [saved.picturePath, eventId],
  );
  try {
    websocketService.emitIsapiFaceContrastEvent({
      id: Number(eventId),
      picturePath: saved.picturePath,
      hasPicture: true,
    });
  } catch (_e) {
    // WS 失敗不影響附圖
  }
  return saved.picturePath;
}

module.exports = {
  persistFaceContrastEvent,
  attachPictureToFaceContrastEvent,
};
