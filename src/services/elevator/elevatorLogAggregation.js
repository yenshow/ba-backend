/**
 * 電梯事件報表合併：刷卡後的多筆開／關門收斂為各一筆
 */
const {
  ACS_DOOR_OPEN_LABEL,
  ACS_DOOR_CLOSE_LABEL,
} = require("../ladderSdk/acsEventLabels");

const SESSION_TAIL_MS = 120_000;
const ORPHAN_GROUP_MS = 5_000;

const isCardSwipe = (log) => log.major === 5 && log.minor === 1;
const isDoorOpen = (log) => log.major === 5 && log.minor === 100;
const isDoorClose = (log) => log.major === 5 && log.minor === 99;
const isRemoteOp = (log) => log.major === 3;
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

const collectOrphanRelayGroup = (asc, startIndex, consumed, minor) => {
  const anchor = asc[startIndex];
  const group = [anchor];
  consumed.add(startIndex);
  const anchorMs = eventMs(anchor);

  for (let j = startIndex + 1; j < asc.length; j++) {
    if (consumed.has(j)) continue;
    const next = asc[j];
    if (next.deviceId !== anchor.deviceId) continue;
    if (next.major !== 5 || next.minor !== minor) continue;
    if (eventMs(next) - anchorMs > ORPHAN_GROUP_MS) break;
    group.push(next);
    consumed.add(j);
  }

  return group;
};

const aggregateElevatorLogs = (logs) => {
  if (!Array.isArray(logs) || logs.length === 0) return [];

  const asc = [...logs].sort((a, b) => eventMs(a) - eventMs(b));
  const consumed = new Set();
  const out = [];

  for (let i = 0; i < asc.length; i++) {
    if (consumed.has(i)) continue;
    const log = asc[i];

    if (isRemoteOp(log) || isRelayEvent(log)) {
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
        if (isCardSwipe(next) || isRemoteOp(next)) break;
        if (isDoorOpen(next)) {
          opens.push(next);
          consumed.add(j);
        } else if (isDoorClose(next)) {
          closes.push(next);
          consumed.add(j);
        }
      }

      if (opens.length) {
        out.push(makeMergedRow(log, opens, ACS_DOOR_OPEN_LABEL, false));
      }
      if (closes.length) {
        out.push(makeMergedRow(log, closes, ACS_DOOR_CLOSE_LABEL, true));
      }
      continue;
    }

    if (isDoorOpen(log) || isDoorClose(log)) {
      const group = collectOrphanRelayGroup(asc, i, consumed, log.minor);
      out.push(
        makeMergedRow(
          group[0],
          group,
          log.event || null,
          isDoorClose(log),
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
