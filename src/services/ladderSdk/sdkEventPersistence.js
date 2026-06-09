/**
 * 梯控 SDK 佈防事件寫入（比照 isapiEventPersistence / vehicle ANPR）
 */
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");

/** major=0x3: 0x400–0x403；major=0x5: 0x01、0x5f、0x60 */
const ALLOWED_EVENTS = new Set([
  "3:1024",
  "3:1025",
  "3:1026",
  "3:1027",
  "5:1",
  "5:95",
  "5:96",
]);

const isProcessableEvent = (major, minor) =>
  ALLOWED_EVENTS.has(`${Number(major)}:${Number(minor)}`);

/**
 * @param {object} options
 * @returns {Promise<{ inserted: boolean, id?: number }>}
 */
const persistLadderSdkEvent = async (options) => {
  const {
    deviceId,
    deviceIp = "",
    eventTime,
    major,
    minor,
    eventName = "",
    floor = null,
    cardNo = null,
    payload = {},
  } = options || {};

  if (!deviceId || !isProcessableEvent(major, minor)) {
    return { inserted: false };
  }

  const rows = await db.query(
    `INSERT INTO ladder_sdk_events (
       device_id, device_ip, event_time, major, minor,
       event_name, floor, card_no, payload
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [
      Number(deviceId),
      String(deviceIp || ""),
      eventTime || new Date().toISOString(),
      Number(major),
      Number(minor),
      eventName || null,
      floor != null ? Number(floor) : null,
      cardNo ? String(cardNo) : null,
      JSON.stringify(payload || {}),
    ],
  );

  const id = rows?.[0]?.id ?? null;
  if (id == null) {
    return { inserted: false };
  }

  websocketService.emitLadderSdkEvent({
    id,
    deviceId: Number(deviceId),
    deviceIp: String(deviceIp || ""),
    eventTime: eventTime || new Date().toISOString(),
    major: Number(major),
    minor: Number(minor),
    eventName: eventName || "",
    floor: floor != null ? Number(floor) : null,
    cardNo: cardNo ? String(cardNo) : null,
  });

  return { inserted: true, id };
};

module.exports = {
  ALLOWED_EVENTS,
  isProcessableEvent,
  persistLadderSdkEvent,
};
