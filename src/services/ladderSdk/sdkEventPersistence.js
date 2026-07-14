/**
 * 梯控 SDK 佈防事件寫入（Bridge 輸出全部 ACS 事件，寫庫前套用白名單）
 * 營運雙寫對齊電梯表：略過門開副作用／呼梯鄰近繼電器；樓層用邏輯顯示名
 */
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const { ALLOWED_EVENT_KEYS } = require("./acsEventLabels");
const { resolveEventCardNo } = require("./ladderSdkCardCorrelation");
const operationalEventService = require("../operationalEvents/operationalEventService");
const { summaryElevator } = require("../operationalEvents/operationalEventCopy");
const {
  resolveElevatorContextByDeviceId,
  shouldOmitOperationalElevatorEvent,
  formatOperationalElevatorFloor,
  markCallElevatorForRelaySuppress,
} = require("../operationalEvents/operationalEventHooks");

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
  const majorN = Number(major);
  const minorN = Number(minor);
  const deviceIdN = Number(deviceId);
  const floorN = floor != null ? Number(floor) : null;
  const safeFloor = Number.isFinite(floorN) ? floorN : null;

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
      deviceIdN,
      String(deviceIp || ""),
      resolvedEventTime,
      majorN,
      minorN,
      eventName || null,
      safeFloor,
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
    deviceId: deviceIdN,
    deviceIp: String(deviceIp || ""),
    eventTime: resolvedEventTime,
    major: majorN,
    minor: minorN,
    eventName: eventName || "",
    floor: safeFloor,
    cardNo: resolvedCardNo,
  });

  const omit = await shouldOmitOperationalElevatorEvent({
    deviceId: deviceIdN,
    major: majorN,
    minor: minorN,
    eventTime: resolvedEventTime,
  });
  if (omit) {
    return { inserted: true, id };
  }

  // 呼梯：標記短窗，避免後續繼電器先／後到達造成營運多記
  if (majorN === 3 && (minorN === 1028 || minorN === 1029)) {
    markCallElevatorForRelaySuppress(deviceIdN);
  }

  const elevCtx = await resolveElevatorContextByDeviceId(deviceIdN);
  const floorLabel = formatOperationalElevatorFloor(safeFloor, elevCtx?.floors);
  void operationalEventService.recordEvent({
    source: "elevator",
    event_kind: "elevator",
    occurred_at: resolvedEventTime,
    location_id: elevCtx?.locationId ?? null,
    system_id: elevCtx?.systemId ?? null,
    device_id: deviceIdN,
    summary: summaryElevator({
      eventName,
      major: majorN,
      minor: minorN,
      floor: floorLabel,
    }),
    ref_table: "ladder_sdk_events",
    ref_id: id,
    payload: {
      major: majorN,
      minor: minorN,
      floor: safeFloor,
      floorLabel: floorLabel || null,
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
