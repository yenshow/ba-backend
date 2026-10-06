/**
 * 門禁機 AcsEvent 歷史查詢（JSON，與攝影機 FCSearch／Traffic 路徑不同）
 * 供訂閱補齊與 scripts/importAccessEventsFromDevice 共用，避免兩套查詢漂移。
 */
const db = require("../../database/db");

const ACS_EVENT_PATH = "/ISAPI/AccessControl/AcsEvent?format=json";
const DEFAULT_PAGE_SIZE = 30;

const asList = (value) => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

function toAcsEventPayload(item) {
  const employee = String(item.employeeNoString ?? item.employeeNo ?? "").trim();
  const name = String(item.name ?? item.personName ?? "").trim();
  const serialNo = item.serialNo != null ? item.serialNo : null;
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
 * @param {{ startTime: string, endTime: string, pageSize?: number, maxPages?: number, onPictureUnsupported?: () => void }} options
 */
async function fetchAcsEvents(client, options) {
  const startTime = String(options?.startTime || "");
  const endTime = String(options?.endTime || "");
  const pageSize = Math.max(1, Number(options?.pageSize) || DEFAULT_PAGE_SIZE);
  const maxPages = Math.max(1, Number(options?.maxPages) || 10);
  const searchID = `ba-acs-${Date.now()}`;
  const events = [];
  let position = 0;
  let withPicture = true;

  for (let page = 0; page < maxPages; page += 1) {
    const cond = {
      searchID,
      searchResultPosition: position,
      maxResults: pageSize,
      major: 5,
      minor: 0,
      startTime,
      endTime,
    };
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

async function findExistingAccessEvent(deviceId, eventTime, payload) {
  const serial = payload.serialNo != null ? String(payload.serialNo) : "";
  const who = String(
    payload.employeeNoString ||
      payload.employeeNo ||
      payload.personName ||
      payload.cardNo ||
      "",
  ).trim();
  const rows = await db.query(
    `SELECT id, picture_path
     FROM isapi_access_events
     WHERE device_id = ?
       AND date_trunc('second', event_time) = date_trunc('second', ?::timestamptz)
       AND COALESCE(payload->>'subEventType', '') = ?
       AND (
         COALESCE(payload->>'serialNo', '') = ?
         OR COALESCE(payload->>'serialNo', '') = ''
         OR ? = ''
       )
       AND (
         ? = ''
         OR COALESCE(
           NULLIF(payload->>'employeeNoString', ''),
           NULLIF(payload->>'employeeNo', ''),
           NULLIF(payload->>'personName', ''),
           NULLIF(payload->>'cardNo', ''),
           ''
         ) IN ('', ?)
       )
     ORDER BY id
     LIMIT 1`,
    [
      deviceId,
      eventTime,
      String(payload.subEventType ?? ""),
      serial,
      serial,
      who,
      who,
    ],
  );
  const row = rows?.[0];
  if (!row) return { id: null, hasPicture: false };
  return {
    id: row.id,
    hasPicture: Boolean(String(row.picture_path || "").trim()),
  };
}

module.exports = {
  ACS_EVENT_PATH,
  toAcsEventPayload,
  fetchAcsEvents,
  findExistingAccessEvent,
};
