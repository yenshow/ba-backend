/**
 * 梯控 SDK 事件查詢（最新紀錄）
 */
const db = require("../../database/db");

const mapEventRow = (row) => ({
  id: row.id,
  deviceId: row.device_id,
  deviceIp: row.device_ip,
  deviceName: row.device_name || null,
  eventTime: row.event_time,
  major: row.major,
  minor: row.minor,
  eventName: row.event_name,
  floor: row.floor,
  cardNo: row.card_no,
  employeeNo: row.employee_no || null,
  personName: row.person_name || null,
  personId: row.person_id || null,
  payload: row.payload,
  createdAt: row.created_at,
});

const listEvents = async (options = {}) => {
  const {
    deviceId,
    cardNo,
    limit = 50,
    offset = 0,
    startTime,
    endTime,
  } = options;

  const where = ["1=1"];
  const params = [];

  if (deviceId != null) {
    where.push("e.device_id = ?");
    params.push(Number(deviceId));
  }
  if (cardNo) {
    where.push("e.card_no = ?");
    params.push(String(cardNo).trim());
  }
  if (startTime) {
    where.push("e.event_time >= ?");
    params.push(startTime);
  }
  if (endTime) {
    where.push("e.event_time <= ?");
    params.push(endTime);
  }

  const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offsetNum = Math.max(Number(offset) || 0, 0);

  const rows = await db.query(
    `SELECT e.*,
            d.name AS device_name,
            p.id AS person_id,
            p.employee_no,
            p.full_name AS person_name
     FROM ladder_sdk_events e
     LEFT JOIN devices d ON d.id = e.device_id
     LEFT JOIN person_ladder_cards plc ON plc.card_no = e.card_no
     LEFT JOIN persons p ON p.id = plc.person_id
     WHERE ${where.join(" AND ")}
     ORDER BY e.event_time DESC
     LIMIT ? OFFSET ?`,
    [...params, limitNum, offsetNum],
  );

  const countRows = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM ladder_sdk_events e
     WHERE ${where.join(" AND ")}`,
    params,
  );

  return {
    items: (rows || []).map(mapEventRow),
    total: countRows?.[0]?.total ?? 0,
    limit: limitNum,
    offset: offsetNum,
  };
};

const getLatestEvents = async (options = {}) => {
  const limit = options.limit ?? 20;
  return listEvents({
    ...options,
    limit,
    offset: 0,
  });
};

module.exports = {
  listEvents,
  getLatestEvents,
};
