/**
 * ISAPI PeopleCounting XML 解析（無額外套件，避免新增依賴）
 * 目標：從 EventNotificationAlert 解析 dateTime、peopleCounting enter/exit、RegionList
 */
function decodeXmlEntities(v) {
  if (v == null) return "";
  return String(v)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function pickTag(xml, tag) {
  if (!xml) return null;
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1]).trim() : null;
}

function pickIntTag(xml, tag) {
  const raw = pickTag(xml, tag);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function pickBoolTag(xml, tag) {
  const raw = pickTag(xml, tag);
  if (raw == null) return null;
  return String(raw).trim().toLowerCase() === "true";
}

function pickBlocks(xml, tag) {
  if (!xml) return [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * 解析 PeopleCounting 事件
 * @param {string} xmlStr - EventNotificationAlert XML
 * @returns {null|{ eventTime: string, deviceIp: string, channelId: number|null, statisticalMethods: string|null, enter: number|null, exit: number|null, regions: Array<{id:number|null,name:string,enter:number|null,exit:number|null}>, isRetransmission: boolean|null }}
 */
function parsePeopleCountingEventXml(xmlStr) {
  const xml = typeof xmlStr === "string" ? xmlStr.trim() : "";
  if (!xml) return null;
  const eventType = pickTag(xml, "eventType");
  if (eventType && String(eventType).toLowerCase() !== "peoplecounting") {
    return null;
  }

  const eventTime = pickTag(xml, "dateTime") || pickTag(xml, "time");
  const deviceIp = pickTag(xml, "ipAddress") || "";
  const channelId = pickIntTag(xml, "channelID");

  // peopleCounting overall
  const peopleCountingBlock = pickBlocks(xml, "peopleCounting")[0] || "";
  const statisticalMethodsRaw = pickTag(peopleCountingBlock, "statisticalMethods");
  const statisticalMethods =
    statisticalMethodsRaw != null && String(statisticalMethodsRaw).trim() !== ""
      ? String(statisticalMethodsRaw).trim()
      : null;
  const enter = pickIntTag(peopleCountingBlock, "enter");
  const exit = pickIntTag(peopleCountingBlock, "exit");

  // regions
  const regionListBlock = pickBlocks(xml, "RegionList")[0] || "";
  const regionBlocks = pickBlocks(regionListBlock, "Region");
  const regions = regionBlocks.map((b) => ({
    id: pickIntTag(b, "id"),
    name: pickTag(b, "name") || "",
    enter: pickIntTag(b, "enter"),
    exit: pickIntTag(b, "exit"),
  }));

  const isRetransmission = pickBoolTag(xml, "isDataRetransmission");

  return {
    eventTime,
    deviceIp,
    channelId,
    statisticalMethods,
    enter,
    exit,
    regions,
    isRetransmission,
  };
}

module.exports = {
  parsePeopleCountingEventXml,
};

