/**
 * ISAPI Traffic / Parking XML 解析（車牌名單查詢、柵欄狀態）
 */
const { extractTag } = require("./isapiVehicleXmlParser");

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
 * @param {string} rawType - 設備 type / listType
 * @returns {'allowList'|'blockList'|string}
 */
function normalizeListTypeToApi(rawType) {
  const t = String(rawType || "").trim().toLowerCase();
  if (t === "whitelist" || t === "white" || t === "allowlist") return "allowList";
  if (t === "blacklist" || t === "black" || t === "blocklist") return "blockList";
  return String(rawType || "").trim() || "allowList";
}

/**
 * @param {'allowList'|'blockList'|string} apiType
 * @returns {'allowList'|'blockList'}
 */
function normalizeListTypeToDevice(apiType) {
  return normalizeListTypeToApi(apiType);
}

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

const BARRIER_STATUS_LABELS = {
  0: "無訊號",
  1: "關閉",
  2: "開啟",
};

/**
 * @param {string} rawXml
 * @returns {{ status: number, label: string }}
 */
function parseBarrierGateStatus(rawXml) {
  const raw = String(rawXml || "")
    .replace(/^\uFEFF/, "")
    .trim();
  const statusStr =
    extractTag(raw, "barrierGateStatus") || extractTag(raw, "BarrierGateStatus");
  const status = Number(statusStr);
  const n = Number.isFinite(status) ? status : 0;
  return {
    status: n,
    label: BARRIER_STATUS_LABELS[n] || `未知(${n})`,
  };
}

module.exports = {
  parseLicensePlateSearchResult,
  parseBarrierGateStatus,
  normalizeListTypeToApi,
  normalizeListTypeToDevice,
  BARRIER_STATUS_LABELS,
};
