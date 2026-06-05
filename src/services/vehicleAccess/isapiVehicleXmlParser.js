/**
 * ISAPI ANPR EventNotificationAlert XML 解析
 * 僅擷取：dateTime、eventType、ANPR.licensePlate、ANPR.listType（契約見 docs/30-contracts/external-integrations.md）
 */
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = String(xml || "").match(re);
  return m ? m[1].trim() : "";
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

module.exports = {
  parseAnprEventXml,
  extractTag,
};
