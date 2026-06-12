/**
 * 電梯事件報表合併：刷卡／手動操作後的多筆開／關門收斂為各一筆
 */
const {
  ACS_DOOR_OPEN_LABEL,
  ACS_DOOR_CLOSE_LABEL,
  ACS_MANUAL_OPEN_LABEL,
  ACS_MANUAL_CLOSE_LABEL,
} = require("../ladderSdk/acsEventLabels");

const SESSION_TAIL_MS = 120_000;
const ORPHAN_GROUP_MS = 5_000;

const isCardSwipe = (log) => log.major === 5 && log.minor === 1;
const isDoorOpen = (log) => log.major === 5 && log.minor === 100;
const isDoorClose = (log) => log.major === 5 && log.minor === 99;
const isRemoteOp = (log) => log.major === 3;
const isManualOpen = (log) => log.major === 3 && log.minor === 1024;
const isManualClose = (log) => log.major === 3 && log.minor === 1025;
const isManualDoorOp = (log) => isManualOpen(log) || isManualClose(log);
const isRelayEvent = (log) =>
  log.major === 5 && (log.minor === 95 || log.minor === 96);

const eventMs = (log) => new Date(log.time).getTime();

const formatFloors = (events) => {
  const floors = [
    ...new Set(
      events
        .map((e) => Number(e.floor))
        .filter((n) => Number.isFinite(n)),
    ),
  ].sort((a, b) => a - b);
  return floors.length ? floors.join("、") : null;
};

const makeMergedRow = (anchor, events, eventLabel, isClose) => {
  const sorted = [...events].sort((a, b) => eventMs(a) - eventMs(b));
  const first = sorted[0] || anchor;
  const last = sorted[sorted.length - 1] || anchor;
  return {
    id: first.id,
    deviceId: anchor.deviceId,
    deviceName: anchor.deviceName,
    personName:
      anchor.personName ||
      first.personName ||
      sorted.find((e) => e.personName)?.personName ||
      null,
    employeeNo: anchor.employeeNo || first.employeeNo || null,
    personId: anchor.personId || first.personId || null,
    floor: formatFloors(sorted),
    event: eventLabel,
    time: isClose ? last.time : first.time,
  };
};

const forEachNearby = (
  asc,
  anchorIndex,
  consumed,
  fn,
  directions = [-1, 1],
) => {
  const anchor = asc[anchorIndex];
  const anchorMs = eventMs(anchor);

  for (const dir of directions) {
    for (
      let j = anchorIndex + dir;
      dir < 0 ? j >= 0 : j < asc.length;
      j += dir
    ) {
      if (consumed.has(j)) continue;
      const other = asc[j];
      if (other.deviceId !== anchor.deviceId) continue;
      if (Math.abs(eventMs(other) - anchorMs) > ORPHAN_GROUP_MS) break;
      const result = fn(other, j);
      if (result !== undefined) return result;
    }
  }

  return undefined;
};

const findNearbyManualDoorLabel = (asc, anchorIndex, consumed, isClose) => {
  const match = isClose ? isManualClose : isManualOpen;
  const fallback = isClose ? ACS_MANUAL_CLOSE_LABEL : ACS_MANUAL_OPEN_LABEL;

  return (
    forEachNearby(asc, anchorIndex, consumed, (other, j) => {
      if (!match(other)) return undefined;
      consumed.add(j);
      return other.event || fallback;
    }) ?? null
  );
};

const findNearbyCardSwipe = (asc, anchorIndex, consumed) =>
  forEachNearby(
    asc,
    anchorIndex,
    consumed,
    (other, j) => {
      if (!isCardSwipe(other)) return undefined;
      consumed.add(j);
      return other;
    },
    [-1],
  ) ?? null;

const collectForward = (asc, startIndex, consumed, match) => {
  const anchor = asc[startIndex];
  const anchorMs = eventMs(anchor);
  const events = [];

  for (let j = startIndex + 1; j < asc.length; j++) {
    if (consumed.has(j)) continue;
    const next = asc[j];
    if (next.deviceId !== anchor.deviceId) continue;
    if (eventMs(next) - anchorMs > ORPHAN_GROUP_MS) break;
    if (!match(next)) continue;
    events.push(next);
    consumed.add(j);
  }

  return events;
};

const collectOrphanRelayGroup = (asc, startIndex, consumed, minor) => {
  const anchor = asc[startIndex];
  consumed.add(startIndex);
  const tail = collectForward(
    asc,
    startIndex,
    consumed,
    (next) => next.major === 5 && next.minor === minor,
  );
  return [anchor, ...tail];
};

const aggregateElevatorLogs = (logs) => {
  if (!Array.isArray(logs) || logs.length === 0) return [];

  const asc = [...logs].sort((a, b) => eventMs(a) - eventMs(b));
  const consumed = new Set();
  const out = [];

  for (let i = 0; i < asc.length; i++) {
    if (consumed.has(i)) continue;
    const log = asc[i];

    if (isRelayEvent(log)) {
      out.push(toPublicLog(log));
      consumed.add(i);
      continue;
    }

    if (isManualDoorOp(log)) {
      consumed.add(i);
      const isClose = isManualClose(log);
      const doorEvents = collectForward(
        asc,
        i,
        consumed,
        isClose ? isDoorClose : isDoorOpen,
      );
      const personAnchor = findNearbyCardSwipe(asc, i, consumed) || log;
      out.push(
        makeMergedRow(
          personAnchor,
          doorEvents.length ? doorEvents : [log],
          log.event || (isClose ? ACS_MANUAL_CLOSE_LABEL : ACS_MANUAL_OPEN_LABEL),
          isClose,
        ),
      );
      continue;
    }

    if (isRemoteOp(log)) {
      out.push(toPublicLog(log));
      consumed.add(i);
      continue;
    }

    if (isCardSwipe(log)) {
      consumed.add(i);
      const sessionEnd = eventMs(log) + SESSION_TAIL_MS;
      const opens = [];
      const closes = [];

      for (let j = i + 1; j < asc.length; j++) {
        if (consumed.has(j)) continue;
        const next = asc[j];
        if (eventMs(next) > sessionEnd) break;
        if (next.deviceId !== log.deviceId) continue;
        if (isCardSwipe(next)) break;
        if (isRemoteOp(next) && !isManualDoorOp(next)) break;
        if (isManualDoorOp(next)) continue;
        if (isDoorOpen(next)) {
          opens.push(next);
          consumed.add(j);
        } else if (isDoorClose(next)) {
          closes.push(next);
          consumed.add(j);
        }
      }

      if (opens.length) {
        out.push(
          makeMergedRow(
            log,
            opens,
            findNearbyManualDoorLabel(asc, i, consumed, false) ||
              ACS_DOOR_OPEN_LABEL,
            false,
          ),
        );
      }
      if (closes.length) {
        out.push(
          makeMergedRow(
            log,
            closes,
            findNearbyManualDoorLabel(asc, i, consumed, true) ||
              ACS_DOOR_CLOSE_LABEL,
            true,
          ),
        );
      }
      continue;
    }

    if (isDoorOpen(log) || isDoorClose(log)) {
      const isClose = isDoorClose(log);
      const manualLabel = findNearbyManualDoorLabel(asc, i, consumed, isClose);
      const group = collectOrphanRelayGroup(asc, i, consumed, log.minor);
      const personAnchor = findNearbyCardSwipe(asc, i, consumed) || group[0];
      out.push(
        makeMergedRow(
          personAnchor,
          group,
          manualLabel || log.event || null,
          isClose,
        ),
      );
      continue;
    }

    out.push(toPublicLog(log));
    consumed.add(i);
  }

  return out.sort((a, b) => eventMs(b) - eventMs(a));
};

const toPublicLog = (log) => {
  const {
    major: _major,
    minor: _minor,
    cardNo: _cardNo,
    ...rest
  } = log;
  return rest;
};

module.exports = {
  aggregateElevatorLogs,
};
