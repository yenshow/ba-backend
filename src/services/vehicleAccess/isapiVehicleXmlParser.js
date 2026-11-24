/**
 * ISAPI 車輛 XML／名單解析
 * - ANPR EventNotificationAlert（訂閱事件）
 * - Traffic／Parking 車牌名單查詢
 * - Traffic vehicleDetect(Result)/search 歷史列
 * - deviceEventId：matchNo／UUID；皆無則車牌圖 path（對齊 SDK dwMatchNo／byUUID）
 */
const { toIsapiUrlPath, pickTag, pickBlocks } = require("../isapi/isapiEventBackfillCommon");

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = String(xml || "").match(re);
  return m ? m[1].trim() : "";
}

function extractAllBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const blocks = [];
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function firstOf(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/**
 * 事件級唯一鍵：matchNo／UUID 優先；後備車牌／車圖 path。
 * 不用車牌字串＋同一秒當身分。
 */
function extractVehicleDeviceEventIdFromXml(block) {
  const text = String(block || "");
  const id = firstOf(
    extractTag(text, "matchNo"),
    extractTag(text, "MatchNo"),
    extractTag(text, "UUID"),
    extractTag(text, "uuid"),
  );
  if (id) return id;
  return toIsapiUrlPath(
    firstOf(
      extractTag(text, "platePicUrl"),
      extractTag(text, "platePicURL"),
      extractTag(text, "vehiclePicUrl"),
      extractTag(text, "vehiclePicURL"),
      extractTag(text, "pictureURL"),
      extractTag(text, "pictureUrl"),
      extractTag(text, "picUrl"),
      extractTag(text, "picURL"),
    ),
  );
}

/**
 * @param {string} rawXml
 * @returns {{
 *   dateTime: string,
 *   eventType: string,
 *   licensePlate: string,
 *   listType: string,
 *   deviceEventId: string|null,
 *   picturePath: string|null,
 * } | null}
 */
function parseAnprEventXml(rawXml) {
  const raw = String(rawXml || "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!raw || !/EventNotificationAlert/i.test(raw)) return null;

  const eventType = extractTag(raw, "eventType");
  if (String(eventType).toUpperCase() !== "ANPR") return null;

  const anprBlock = extractTag(raw, "ANPR") || raw;
  const licensePlate = extractTag(anprBlock, "licensePlate");
  const listType = extractTag(anprBlock, "listType");
  const dateTime = extractTag(raw, "dateTime");
  const picturePath = toIsapiUrlPath(
    firstOf(
      extractTag(anprBlock, "platePicUrl"),
      extractTag(anprBlock, "platePicURL"),
      extractTag(anprBlock, "vehiclePicUrl"),
      extractTag(anprBlock, "vehiclePicURL"),
      extractTag(anprBlock, "pictureURL"),
      extractTag(anprBlock, "pictureUrl"),
      extractTag(raw, "pictureURL"),
    ),
  );
  const deviceEventId =
    extractVehicleDeviceEventIdFromXml(anprBlock) ||
    extractVehicleDeviceEventIdFromXml(raw) ||
    picturePath;

  return {
    dateTime: dateTime || new Date().toISOString(),
    eventType: String(eventType).trim() || "ANPR",
    licensePlate,
    listType,
    deviceEventId: deviceEventId || null,
    picturePath: picturePath || null,
  };
}

/**
 * Traffic search 結果列 → { licensePlate, dateTime, listType, deviceEventId, picturePath }
 * @param {string} xml
 * @returns {{ rows: object[], status: string }}
 */
function parseVehicleSearchResult(xml) {
  const text = String(xml || "");
  const blocks = [
    ...pickBlocks(text, "MatchElement"),
    ...pickBlocks(text, "VehicleDetectResult"),
    ...pickBlocks(text, "ITCResult"),
  ];
  const out = [];
  for (const block of blocks) {
    const plate =
      pickTag(block, "licensePlate") ||
      pickTag(block, "LicensePlate") ||
      pickTag(block, "plateNo");
    const dateTime =
      pickTag(block, "dateTime") ||
      pickTag(block, "absoluteTime") ||
      pickTag(block, "time");
    const listType =
      pickTag(block, "listType") ||
      pickTag(block, "vehicleType") ||
      pickTag(block, "plateType");
    if (!plate || !dateTime) continue;
    const picturePath = toIsapiUrlPath(
      firstOf(
        pickTag(block, "platePicUrl"),
        pickTag(block, "platePicURL"),
        pickTag(block, "vehiclePicUrl"),
        pickTag(block, "vehiclePicURL"),
        pickTag(block, "pictureURL"),
        pickTag(block, "pictureUrl"),
        pickTag(block, "picUrl"),
        pickTag(block, "picURL"),
      ),
    );
    const deviceEventId =
      firstOf(
        pickTag(block, "matchNo"),
        pickTag(block, "MatchNo"),
        pickTag(block, "UUID"),
        pickTag(block, "uuid"),
      ) || picturePath;
    out.push({
      licensePlate: plate,
      dateTime:
        dateTime.includes("+") || /Z$/i.test(dateTime)
          ? dateTime
          : `${dateTime}+08:00`,
      listType: listType || null,
      eventType: "ANPR",
      deviceEventId: deviceEventId || null,
      picturePath: picturePath || null,
    });
  }
  return {
    rows: out,
    status: String(pickTag(text, "responseStatusStrg") || "").toUpperCase(),
  };
}

/**
 * @param {string} rawType - 設備 type / listType
 * @returns {'allowList'|'blockList'|string}
 */
function normalizeListTypeToApi(rawType) {
  const t = String(rawType || "").trim().toLowerCase();
  if (t === "whitelist" || t === "white" || t === "allowlist") return "allowList";
  if (t === "blacklist" || t === "black" || t === "blocklist") return "blockList";
  // 名單 CRUD：未知／空 → 預設白名單（勿把 ANPR 陌生語意寫進人員車牌）
  return "allowList";
}

/** 設備寫入與 API 使用同一組 allowList／blockList 鍵名 */
const normalizeListTypeToDevice = normalizeListTypeToApi;

/**
 * @param {string} rawXml
 * @returns {{ items: object[], numOfMatches?: number, totalMatches?: number }}
 */
function parseLicensePlateSearchResult(rawXml) {
  const raw = String(rawXml || "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!raw) return { items: [] };

  const listBlock = extractTag(raw, "LicensePlateInfoList") || raw;
  const numOfMatches = extractTag(listBlock, "numOfMatches");
  const totalMatches = extractTag(listBlock, "totalMatches");

  const blocks = extractAllBlocks(listBlock, "LicensePlateInfo");
  const items = blocks.map((block) => {
    const licensePlate =
      extractTag(block, "LicensePlate") || extractTag(block, "licensePlate");
    const id = extractTag(block, "id") || licensePlate;
    const typeRaw = extractTag(block, "type") || extractTag(block, "listType");
    return {
      id: id || licensePlate,
      licensePlate: licensePlate || id,
      listType: normalizeListTypeToApi(typeRaw),
      createTime: extractTag(block, "createTime") || null,
      effectiveTime: extractTag(block, "effectiveTime") || null,
    };
  });

  return {
    items,
    numOfMatches: numOfMatches ? Number(numOfMatches) : items.length,
    totalMatches: totalMatches ? Number(totalMatches) : items.length,
  };
}

module.exports = {
  extractTag,
  parseAnprEventXml,
  parseVehicleSearchResult,
  extractVehicleDeviceEventIdFromXml,
  parseLicensePlateSearchResult,
  normalizeListTypeToApi,
  normalizeListTypeToDevice,
};
