/**
 * ISAPI 攝影機 PeopleCounting 事件落地（enter/exit 累計 + 與前筆之差）
 */
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const operationalEventService = require("../operationalEvents/operationalEventService");
const {
  summaryPeopleCounting,
} = require("../operationalEvents/operationalEventCopy");
const {
  loadPlaceContextByLocationId,
} = require("../operationalEvents/operationalEventPlaceContext");

function safeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

async function getPreviousRowTotals(options) {
  const { locationId, deviceId, channelId, regionId, eventTime } = options;
  const regionSql =
    regionId == null ? "AND region_id IS NULL" : "AND region_id = ?";
  const params =
    regionId == null
      ? [locationId, deviceId, channelId, eventTime]
      : [locationId, deviceId, channelId, regionId, eventTime];
  const rows = await db.query(
    `SELECT enter, "exit"
     FROM isapi_people_counting_events
     WHERE location_id = ?
       AND device_id = ?
       AND channel_id = ?
       ${regionSql}
       AND event_time < ?
     ORDER BY event_time DESC
     LIMIT 1`,
    params,
  );
  const r = rows?.[0];
  if (!r) return null;
  return {
    enter: safeInt(r.enter),
    exit: safeInt(r.exit),
  };
}

/** 僅供寫入 enter_delta/exit_delta，供 getSiteLogs 判斷進／離方向 */
function computeDelta(prev, currEnter, currExit) {
  if (!Number.isFinite(currEnter) || !Number.isFinite(currExit)) {
    return { enterDelta: 0, exitDelta: 0 };
  }
  if (!prev) return { enterDelta: 0, exitDelta: 0 };
  const prevEnter = safeInt(prev.enter) ?? 0;
  const prevExit = safeInt(prev.exit) ?? 0;
  const dEnter = currEnter - prevEnter;
  const dExit = currExit - prevExit;
  if (dEnter < 0 || dExit < 0) {
    return { enterDelta: 0, exitDelta: 0 };
  }
  return {
    enterDelta: dEnter > 0 ? dEnter : 0,
    exitDelta: dExit > 0 ? dExit : 0,
  };
}

/**
 * 寫入一筆 PeopleCounting 事件（目前僅用於 region 列）
 * 同一 event_time 重複仍由 DB unique + ON CONFLICT DO NOTHING 擋下
 */
async function persistPeopleCountingEvent(options) {
  const {
    locationId,
    deviceId,
    deviceIp,
    channelId = 1,
    regionId = null,
    regionName = null,
    eventTime,
    enter,
    exit: exitVal,
    isRetransmission = false,
  } = options || {};

  if (!locationId || !deviceId || !eventTime) {
    return { inserted: false, id: null };
  }

  const enterNum = safeInt(enter);
  const exitNum = safeInt(exitVal);
  if (!Number.isFinite(enterNum) || !Number.isFinite(exitNum)) {
    return { inserted: false, id: null };
  }

  const prev = await getPreviousRowTotals({
    locationId,
    deviceId,
    channelId,
    regionId,
    eventTime,
  });

  const { enterDelta, exitDelta } = computeDelta(prev, enterNum, exitNum);

  const conflictSql =
    regionId == null
      ? "ON CONFLICT (device_id, channel_id, event_time) WHERE region_id IS NULL DO NOTHING"
      : "ON CONFLICT (device_id, channel_id, region_id, event_time) WHERE region_id IS NOT NULL DO NOTHING";

  const rows = await db.query(
    `INSERT INTO isapi_people_counting_events
      (location_id, device_id, device_ip, channel_id, region_id, region_name, event_time,
       enter, "exit", enter_delta, exit_delta, is_retransmission)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ${conflictSql}
     RETURNING id`,
    [
      locationId,
      deviceId,
      deviceIp || "",
      channelId,
      regionId,
      regionName,
      eventTime,
      enterNum,
      exitNum,
      enterDelta,
      exitDelta,
      !!isRetransmission,
    ],
  );

  const id = rows?.[0]?.id ?? null;
  const inserted = id != null;

  if (inserted) {
    const currentCount = enterNum - exitNum;
    websocketService.emitIsapiPeopleCountingEvent({
      locationId,
      deviceId,
      channelId,
      regionId,
      regionName,
      eventTime,
      enter: enterNum,
      exit: exitNum,
      currentCount,
    });
    if (enterDelta > 0 || exitDelta > 0) {
      const placeCtx = await loadPlaceContextByLocationId(locationId);
      void operationalEventService.recordEvent({
        source: "people_counting",
        event_kind: "access",
        created_at: eventTime,
        location_id: locationId,
        device_id: deviceId,
        message: summaryPeopleCounting({
          regionName,
          enterDelta,
          exitDelta,
          placeLabel: placeCtx.placeLabel,
        }),
        ref_table: "isapi_people_counting_events",
        ref_id: id,
        payload: {
          accessKind: "camera",
          enter: enterNum,
          exit: exitNum,
          enterDelta,
          exitDelta,
          regionId,
        },
      });
    }
  }

  return { inserted, id };
}

module.exports = {
  persistPeopleCountingEvent,
};
