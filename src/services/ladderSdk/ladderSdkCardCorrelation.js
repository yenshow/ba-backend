/**
 * 梯控開／關門事件卡號關聯（記憶體快取 + DB 回查，寫入 SSOT）
 */
const db = require("../../database/db");

const CARD_SESSION_MS = 120_000;

/** @type {Map<number, { cardNo: string, at: number }>} */
const lastSwipeByDevice = new Map();

const parseEventMs = (eventTime) => {
  const ms = eventTime ? Date.parse(eventTime) : NaN;
  return Number.isFinite(ms) ? ms : Date.now();
};

const lookupRecentCardNo = async (deviceId, eventTime) => {
  const resolvedTime = eventTime || new Date().toISOString();
  const eventMs = parseEventMs(resolvedTime);
  const windowStart = new Date(
    eventMs - CARD_SESSION_MS,
  ).toISOString();

  const rows = await db.query(
    `SELECT card_no
     FROM ladder_sdk_events
     WHERE device_id = ?
       AND major = 5 AND minor = 1
       AND card_no IS NOT NULL AND card_no <> ''
       AND event_time <= ?
       AND event_time >= ?
     ORDER BY event_time DESC
     LIMIT 1`,
    [Number(deviceId), resolvedTime, windowStart],
  );
  const card = rows?.[0]?.card_no;
  return card ? String(card).trim() : null;
};

const resolveEventCardNo = async ({
  deviceId,
  eventTime,
  major,
  minor,
  cardNo,
}) => {
  const trimmed = cardNo ? String(cardNo).trim() : "";
  const majorNum = Number(major);
  const minorNum = Number(minor);
  const eventMs = parseEventMs(eventTime);

  if (majorNum === 5 && minorNum === 1 && trimmed) {
    lastSwipeByDevice.set(Number(deviceId), { cardNo: trimmed, at: eventMs });
    return trimmed;
  }
  if (trimmed) return trimmed;

  if (majorNum === 5 && (minorNum === 99 || minorNum === 100) && deviceId) {
    const cached = lastSwipeByDevice.get(Number(deviceId));
    if (cached && eventMs - cached.at <= CARD_SESSION_MS) {
      return cached.cardNo;
    }
    return (await lookupRecentCardNo(deviceId, eventTime)) || null;
  }

  return null;
};

module.exports = {
  resolveEventCardNo,
};
