/**
 * 梯控 SDK 佈防事件寫入（Bridge 輸出全部 ACS 事件，寫庫前套用白名單）
 */
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const { ALLOWED_EVENT_KEYS } = require("./acsEventLabels");
const { resolveEventCardNo } = require("./ladderSdkCardCorrelation");
const operationalEventService = require("../operationalEvents/operationalEventService");
const { summaryElevator } = require("../operationalEvents/operationalEventCopy");

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

  void operationalEventService.recordEvent({
    source: "elevator",
    event_kind: "elevator",
    occurred_at: resolvedEventTime,
    device_id: Number(deviceId),
    summary: summaryElevator({
      eventName,
      major: Number(major),
      minor: Number(minor),
    }),
    ref_table: "ladder_sdk_events",
    ref_id: id,
    payload: {
      major: Number(major),
      minor: Number(minor),
      floor: floor != null ? Number(floor) : null,
      cardNo: resolvedCardNo,
    },
  });

  return { inserted: true, id };
};

/** 平台 API visitor_call 成功後寫入稽核（呼梯設備未必有佈防） */
const recordPlatformCallElevator = async ({ deviceId, gatewayIndex }) =>
  persistLadderSdkEvent({
    deviceId,
    major: 3,
    minor: 1028,
    eventName: "訪客呼梯",
    floor: gatewayIndex != null ? Number(gatewayIndex) : null,
    payload: { source: "platform_call", command: "visitor_call" },
  });

module.exports = {
  persistLadderSdkEvent,
  recordPlatformCallElevator,
};
