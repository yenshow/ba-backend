/**
 * ISAPI ANPR EventNotificationAlert XML 解析
 */
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = String(xml || "").match(re);
  return m ? m[1].trim() : "";
}

function parsePictureInfoList(xml) {
  const list = [];
  const block = extractTag(xml, "pictureInfoList");
  if (!block) return list;
  const re = /<pictureInfo>[\s\S]*?<\/pictureInfo>/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const part = m[0];
    list.push({
      type: extractTag(part, "type"),
      fileName: extractTag(part, "fileName"),
    });
  }
  return list;
}

/**
 * @param {string} rawXml
 * @returns {object|null}
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
  const line = extractTag(anprBlock, "line");
  const direction = extractTag(anprBlock, "direction");
  const listType = extractTag(anprBlock, "listType");

  const dateTime = extractTag(raw, "dateTime");
  const pictureInfoList = parsePictureInfoList(anprBlock);

  return {
    eventType: "ANPR",
    dateTime: dateTime || new Date().toISOString(),
    licensePlate,
    line,
    direction,
    listType,
    pictureInfoList,
    payload: {
      dateTime,
      eventType: "ANPR",
      listType,
      ANPR: {
        licensePlate,
        line,
        direction,
      },
    },
  };
}

module.exports = {
  parseAnprEventXml,
  extractTag,
};
