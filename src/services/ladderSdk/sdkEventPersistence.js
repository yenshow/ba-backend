/**
 * 梯控 SDK 佈防事件寫入（Bridge 輸出全部 ACS 事件，寫庫前套用白名單）
 */
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const { resolveEventCardNo } = require("./ladderSdkCardCorrelation");

/** major=0x3: 0x400–0x403；major=0x5: 0x01、0x5f、0x60、0x63、0x64 */
const ALLOWED_EVENT_KEYS = new Set([
  "3:1024",
  "3:1025",
  "3:1026",
  "3:1027",
  "3:1028",
  "3:1029",
  "5:1",
  "5:95",
  "5:96",
  "5:99",
  "5:100",
]);

const isAllowedEvent = (major, minor) =>
  ALLOWED_EVENT_KEYS.has(`${Number(major)}:${Number(minor)}`);

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

  if (!deviceId || !isAllowedEvent(major, minor)) {
    return { inserted: false };
  }

  const resolvedEventTime = eventTime || new Date().toISOString();
  const resolvedCardNo = await resolveEventCardNo({
    deviceId,
    eventTime: resolvedEventTime,
    major,
    minor,
    cardNo,
  });

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
      resolvedEventTime,
      Number(major),
      Number(minor),
      eventName || null,
      floor != null ? Number(floor) : null,
      resolvedCardNo,
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
    eventTime: resolvedEventTime,
    major: Number(major),
    minor: Number(minor),
    eventName: eventName || "",
    floor: floor != null ? Number(floor) : null,
    cardNo: resolvedCardNo,
  });

  return { inserted: true, id };
};

const CALL_EVENT_BY_COMMAND = {
  visitor_call: { minor: 1028, eventName: "訪客呼梯" },
};

/**
 * 平台 API 呼梯成功後寫入稽核事件（呼梯設備未必有佈防）
 */
const recordPlatformCallElevator = async ({
  deviceId,
  gatewayIndex,
  command,
}) => {
  const key = String(command || "visitor_call").trim().toLowerCase();
  const meta = CALL_EVENT_BY_COMMAND[key] ?? CALL_EVENT_BY_COMMAND.visitor_call;
  return persistLadderSdkEvent({
    deviceId,
    eventTime: new Date().toISOString(),
    major: 3,
    minor: meta.minor,
    eventName: meta.eventName,
    floor: gatewayIndex != null ? Number(gatewayIndex) : null,
    payload: { source: "platform_call", command: key },
  });
};

module.exports = {
  persistLadderSdkEvent,
  recordPlatformCallElevator,
};
