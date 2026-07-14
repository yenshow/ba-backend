/**
 * 電梯事件報表合併：刷卡／手動開門收斂；略過關閉類與呼梯副作用繼電器事件
 */
const {
  ACS_DOOR_OPEN_LABEL,
  ACS_MANUAL_OPEN_LABEL,
} = require("../ladderSdk/acsEventLabels");

const SESSION_TAIL_MS = 120_000;
const ORPHAN_GROUP_MS = 5_000;
const CALL_RELAY_SUPPRESS_MS = ORPHAN_GROUP_MS * 2;

const isCardSwipe = (log) => log.major === 5 && log.minor === 1;
const isDoorOpen = (log) => log.major === 5 && log.minor === 100;
const isDoorClose = (log) => log.major === 5 && log.minor === 99;
const isManualOpen = (log) => log.major === 3 && log.minor === 1024;
const isManualClose = (log) => log.major === 3 && log.minor === 1025;
const isCallElevator = (log) =>
  log.major === 3 && (log.minor === 1028 || log.minor === 1029);
const isRelayEvent = (log) =>
  log.major === 5 && (log.minor === 95 || log.minor === 96);

/** major/minor 版（營運雙寫略過判斷） */
const isAcsDoorOpenSideEffect = (major, minor) =>
  isDoorOpen({ major: Number(major), minor: Number(minor) });
const isAcsRelayEvent = (major, minor) =>
  isRelayEvent({ major: Number(major), minor: Number(minor) });

const isSuppressedEvent = (log) => isDoorClose(log) || isManualClose(log);
const isPassThroughRemoteOp = (log) =>
  log.major === 3 && !isManualOpen(log) && !isSuppressedEvent(log);

const eventMs = (log) => new Date(log.time).getTime();

const formatFloors = (events) => {
  const floors = [
    ...new Set(
      events.map((e) => Number(e.floor)).filter((n) => Number.isFinite(n)),
    ),
  ].sort((a, b) => a - b);
  return floors.length ? floors.join("、") : null;
};

const makeMergedRow = (anchor, events, eventLabel) => {
  const sorted = [...events].sort((a, b) => eventMs(a) - eventMs(b));
  const first = sorted[0] || anchor;
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
    time: first.time,
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

const findNearbyManualOpenLabel = (asc, anchorIndex, consumed) =>
  forEachNearby(asc, anchorIndex, consumed, (other, j) => {
    if (!isManualOpen(other)) return undefined;
    consumed.add(j);
    return other.event || ACS_MANUAL_OPEN_LABEL;
  }) ?? null;

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
  const callEventTimes = asc.filter(isCallElevator).map(eventMs);
  const isNearCallElevator = (log) => {
    if (!callEventTimes.length) return false;
    const ms = eventMs(log);
    return callEventTimes.some(
      (t) => Math.abs(ms - t) <= CALL_RELAY_SUPPRESS_MS,
    );
  };
  const isCallRelaySideEffect = (log) =>
    isNearCallElevator(log) && (isRelayEvent(log) || isDoorOpen(log));

  const consumed = new Set();
  const out = [];

  for (let i = 0; i < asc.length; i++) {
    if (consumed.has(i)) continue;
    const log = asc[i];

    if (isSuppressedEvent(log) || isCallRelaySideEffect(log)) {
      consumed.add(i);
      continue;
    }

    if (isRelayEvent(log)) {
      out.push(toPublicLog(log));
      consumed.add(i);
      continue;
    }

    if (isManualOpen(log)) {
      consumed.add(i);
      const doorEvents = collectForward(asc, i, consumed, isDoorOpen);
      const personAnchor = findNearbyCardSwipe(asc, i, consumed) || log;
      out.push(
        makeMergedRow(
          personAnchor,
          doorEvents.length ? doorEvents : [log],
          log.event || ACS_MANUAL_OPEN_LABEL,
        ),
      );
      continue;
    }

    if (isPassThroughRemoteOp(log)) {
      out.push(toPublicLog(log));
      consumed.add(i);
      continue;
    }

    if (isCardSwipe(log)) {
      consumed.add(i);
      const sessionEnd = eventMs(log) + SESSION_TAIL_MS;
      const opens = [];

      for (let j = i + 1; j < asc.length; j++) {
        if (consumed.has(j)) continue;
        const next = asc[j];
        if (eventMs(next) > sessionEnd) break;
        if (next.deviceId !== log.deviceId) continue;
        if (isCardSwipe(next)) break;
        if (isPassThroughRemoteOp(next)) break;
        if (isManualOpen(next)) continue;
        if (isSuppressedEvent(next) || isCallRelaySideEffect(next)) {
          consumed.add(j);
          continue;
        }
        if (isDoorOpen(next)) {
          opens.push(next);
          consumed.add(j);
        }
      }

      if (opens.length) {
        out.push(
          makeMergedRow(
            log,
            opens,
            findNearbyManualOpenLabel(asc, i, consumed) ||
              ACS_DOOR_OPEN_LABEL,
          ),
        );
      }
      continue;
    }

    if (isDoorOpen(log)) {
      const manualLabel = findNearbyManualOpenLabel(asc, i, consumed);
      const group = collectOrphanRelayGroup(asc, i, consumed, log.minor);
      const personAnchor = findNearbyCardSwipe(asc, i, consumed) || group[0];
      out.push(
        makeMergedRow(
          personAnchor,
          group,
          manualLabel || log.event || ACS_DOOR_OPEN_LABEL,
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
  const { major: _major, minor: _minor, cardNo: _cardNo, ...rest } = log;
  return rest;
};

module.exports = {
  aggregateElevatorLogs,
  CALL_RELAY_SUPPRESS_MS,
  isAcsDoorOpenSideEffect,
  isAcsRelayEvent,
};
