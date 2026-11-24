/**
 * 門禁機 AcsEvent 歷史查詢（JSON，與攝影機 FCSearch／Traffic 路徑不同）
 * 供訂閱 serialNo 補齊與 scripts/ops/importAccessEventsFromDevice 共用。
 */
const db = require("../../database/db");

const ACS_EVENT_PATH = "/ISAPI/AccessControl/AcsEvent?format=json";
const DEFAULT_PAGE_SIZE = 30;

const asList = (value) => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

/** @param {unknown} raw */
function parseSerialNo(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function toAcsEventPayload(item) {
  const employee = String(item.employeeNoString ?? item.employeeNo ?? "").trim();
  const name = String(item.name ?? item.personName ?? "").trim();
  const serialNo = parseSerialNo(item.serialNo);
  return {
    majorEventType: Number(item.major ?? item.majorEventType),
    subEventType: Number(item.minor ?? item.subEventType),
    employeeNoString: employee,
    employeeNo: employee,
    personName: name,
    cardNo: item.cardNo != null ? String(item.cardNo) : "",
    serialNo,
    doorNo: item.doorNo ?? null,
    cardReaderNo: item.cardReaderNo ?? null,
    currentVerifyMode: item.currentVerifyMode ?? "",
    userType: item.userType ?? "",
    cardType: item.cardType ?? null,
    pictureURL: item.pictureURL != null ? String(item.pictureURL) : "",
  };
}

/**
 * @param {{ request: Function }} client
 * @param {{
 *   startTime?: string,
 *   endTime?: string,
 *   beginSerialNo?: number|null,
 *   endSerialNo?: number|null,
 *   pageSize?: number,
 *   maxPages?: number,
 *   onPictureUnsupported?: () => void
 * }} options
 */
async function fetchAcsEvents(client, options) {
  const startTime =
    options?.startTime != null && String(options.startTime).trim()
      ? String(options.startTime).trim()
      : "";
  const endTime =
    options?.endTime != null && String(options.endTime).trim()
      ? String(options.endTime).trim()
      : "";
  const beginSerialNo = parseSerialNo(options?.beginSerialNo);
  const endSerialNo = parseSerialNo(options?.endSerialNo);
  const pageSize = Math.max(1, Number(options?.pageSize) || DEFAULT_PAGE_SIZE);
  const maxPages = Math.max(1, Number(options?.maxPages) || 10);
  const searchID = `ba-acs-${Date.now()}`;
  const events = [];
  let position = 0;
  let withPicture = true;

  for (let page = 0; page < maxPages; page += 1) {
    /** @type {Record<string, unknown>} */
    const cond = {
      searchID,
      searchResultPosition: position,
      maxResults: pageSize,
      major: 5,
      minor: 0,
    };
    if (startTime) cond.startTime = startTime;
    if (endTime) cond.endTime = endTime;
    // 對齊 SDK NET_DVR_ACS_EVENT_COND.dwBeginSerialNo / dwEndSerialNo
    if (beginSerialNo != null) cond.beginSerialNo = beginSerialNo;
    if (endSerialNo != null && endSerialNo > 0) cond.endSerialNo = endSerialNo;

    let res;
    try {
      res = await client.request({
        method: "POST",
        path: ACS_EVENT_PATH,
        data: {
          AcsEventCond: withPicture ? { ...cond, picEnable: true } : cond,
        },
      });
    } catch (error) {
      if (!withPicture) throw error;
      withPicture = false;
      if (typeof options?.onPictureUnsupported === "function") {
        options.onPictureUnsupported(error);
      }
      page -= 1;
      continue;
    }
    const body = res.data || {};
    const acs = body.AcsEvent || body.acsEvent || body;
    const infoList = asList(acs.InfoList || acs.infoList);
    events.push(...infoList);
    const status = String(
      acs.responseStatusStrg || acs.responseStatusString || "",
    ).toUpperCase();
    const matched = Number(acs.numOfMatches) || infoList.length;
    if (
      infoList.length === 0 ||
      status === "OK" ||
      status === "NO MATCH" ||
      status === "NO MATCHES"
    ) {
      break;
    }
    const next = position + (matched > 0 ? matched : infoList.length);
    if (next <= position) break;
    position = next;
  }
  return events;
}

/**
 * 去重：device_id + serialNo（嚴格）。無 serialNo 則視為無法比對。
 * @param {number} deviceId
 * @param {object} payload
 */
async function findExistingAccessEvent(deviceId, payload) {
  const serial = parseSerialNo(payload?.serialNo);
  if (serial == null) return { id: null, hasPicture: false };
  const rows = await db.query(
    `SELECT id, picture_path
     FROM isapi_access_events
     WHERE device_id = ?
       AND COALESCE(payload->>'serialNo', '') = ?
     ORDER BY id
     LIMIT 1`,
    [deviceId, String(serial)],
  );
  const row = rows?.[0];
  if (!row) return { id: null, hasPicture: false };
  return {
    id: row.id,
    hasPicture: Boolean(String(row.picture_path || "").trim()),
  };
}

/**
 * 該設備已入庫的最大 serialNo（可重啟恢復的水位）。
 * @param {number} deviceId
 * @returns {Promise<number|null>}
 */
async function getMaxStoredSerialNo(deviceId) {
  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const rows = await db.query(
    `SELECT MAX((payload->>'serialNo')::bigint) AS max_serial
     FROM isapi_access_events
     WHERE device_id = ?
       AND COALESCE(payload->>'serialNo', '') ~ '^[0-9]+$'`,
    [id],
  );
  const raw = rows?.[0]?.max_serial;
  return parseSerialNo(raw);
}

module.exports = {
  ACS_EVENT_PATH,
  parseSerialNo,
  toAcsEventPayload,
  fetchAcsEvents,
  findExistingAccessEvent,
  getMaxStoredSerialNo,
};
