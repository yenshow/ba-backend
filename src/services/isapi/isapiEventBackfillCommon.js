/**
 * ISAPI 共用工具：時間格式、輕量 XML／圖檔、debounce（NVR／門禁圖檔／catch-up 共用）。
 */
const DEFAULT_DEBOUNCE_MS = 1500;

/** Asia/Taipei 偏移字串（AcsEvent／FCSearch／Traffic／NVR CMSearch 常用） */
function formatIsapiLocalDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+08:00`;
}

/** CMSearch 常回無時區或 `Z`（設備當本地牆鐘）→ 台北 +08:00；已有偏移則原樣 */
function normalizeNvrWallClockDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  const m = raw.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z)?$/i,
  );
  if (!m) return raw;
  return `${m[1]}T${m[2]}+08:00`;
}

function pickTag(xml, tag) {
  if (!xml || typeof xml !== "string") return null;
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? String(m[1]).trim() : null;
}

function pickBlocks(xml, tag) {
  if (!xml || typeof xml !== "string") return [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gi");
  return xml.match(re) || [];
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 絕對 URL → ISAPI path；相對 path 原樣 */
function toIsapiUrlPath(absoluteOrPath) {
  const raw = decodeXmlEntities(String(absoluteOrPath || "").trim());
  if (!raw) return null;
  if (raw.startsWith("/")) return raw;
  try {
    const u = new URL(raw);
    return `${u.pathname}${u.search || ""}`;
  } catch {
    return raw.startsWith("ISAPI/") ? `/${raw}` : raw;
  }
}

function responseBodyToString(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data || "");
}

function isImageBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50) return true;
  return false;
}

/**
 * @param {{ request: Function }} client
 * @param {string} urlOrPath
 * @returns {Promise<Buffer|null>}
 */
async function downloadIsapiPicture(client, urlOrPath) {
  const path = toIsapiUrlPath(urlOrPath);
  if (!path || !client?.request) return null;
  try {
    const res = await client.request({
      method: "GET",
      path,
      responseType: "arraybuffer",
    });
    const buf = Buffer.isBuffer(res.data)
      ? res.data
      : Buffer.from(res.data || []);
    return isImageBuffer(buf) ? buf : null;
  } catch {
    return null;
  }
}

/**
 * @param {number} [debounceMs]
 * @returns {{ schedule: (key: string, run: () => Promise<void>) => void, clear: () => void }}
 */
function createDebouncedScheduler(debounceMs = DEFAULT_DEBOUNCE_MS) {
  /** @type {Map<string, { timer: ReturnType<typeof setTimeout>, run: () => Promise<void>, inflight: boolean }>} */
  const pending = new Map();

  const schedule = (key, run) => {
    const k = String(key || "");
    if (!k || typeof run !== "function") return;
    const prev = pending.get(k);
    if (prev?.timer) clearTimeout(prev.timer);
    const entry = {
      timer: setTimeout(async () => {
        const cur = pending.get(k);
        if (!cur || cur.inflight) return;
        cur.inflight = true;
        try {
          await cur.run();
        } finally {
          pending.delete(k);
        }
      }, Math.max(0, Number(debounceMs) || DEFAULT_DEBOUNCE_MS)),
      run,
      inflight: false,
    };
    pending.set(k, entry);
  };

  const clear = () => {
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    pending.clear();
  };

  return { schedule, clear };
}

/** 人臉／車牌歷史查詢協議時間窗（秒）；非表單設定、不用作事件身分 */
const PROTOCOL_LOOKBACK_SEC = 120;

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  PROTOCOL_LOOKBACK_SEC,
  formatIsapiLocalDateTime,
  normalizeNvrWallClockDateTime,
  pickTag,
  pickBlocks,
  decodeXmlEntities,
  toIsapiUrlPath,
  responseBodyToString,
  isImageBuffer,
  downloadIsapiPicture,
  createDebouncedScheduler,
};
