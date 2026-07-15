/**
 * ISAPI 車輛 XML／名單解析
 * - ANPR EventNotificationAlert（訂閱事件）
 * - Traffic／Parking 車牌名單查詢
 */

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

/**
 * @param {string} rawXml
 * @returns {{ dateTime: string, eventType: string, licensePlate: string, listType: string } | null}
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

  return {
    dateTime: dateTime || new Date().toISOString(),
    eventType: String(eventType).trim() || "ANPR",
    licensePlate,
    listType,
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
  return String(rawType || "").trim() || "allowList";
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
  parseLicensePlateSearchResult,
  normalizeListTypeToApi,
  normalizeListTypeToDevice,
};
