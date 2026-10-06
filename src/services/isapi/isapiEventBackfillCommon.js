/**
 * ISAPI 事件補齊共用：視窗秒數、時間區間、debounce、輕量 XML／圖檔工具
 * 人臉（FCSearch）／門禁（AcsEvent JSON）／車牌（Traffic search）各自呼叫不同設備 API；
 * 此檔只放真正共用的排程與字串工具，不混用查詢路徑。
 */
const DEFAULT_WINDOW_SEC = 5;
const MIN_WINDOW_SEC = 1;
const MAX_WINDOW_SEC = 30;
const DEFAULT_DEBOUNCE_MS = 1500;

function normalizeEventBackfillEnabled(raw) {
  if (raw === true || raw === 1 || raw === "1" || raw === "true") return true;
  if (raw === false || raw === 0 || raw === "0" || raw === "false") return false;
  return false;
}

function normalizeEventBackfillWindowSec(raw) {
  if (raw == null || raw === "") return DEFAULT_WINDOW_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_SEC;
  return Math.min(MAX_WINDOW_SEC, Math.max(MIN_WINDOW_SEC, Math.trunc(n)));
}

/**
 * @param {object} raw - snake 或 camel
 * @returns {{ eventBackfillEnabled: boolean, eventBackfillWindowSec: number }}
 */
function parseEventBackfillFields(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  return {
    eventBackfillEnabled: normalizeEventBackfillEnabled(
      cfg.event_backfill_enabled ?? cfg.eventBackfillEnabled,
    ),
    eventBackfillWindowSec: normalizeEventBackfillWindowSec(
      cfg.event_backfill_window_sec ?? cfg.eventBackfillWindowSec,
    ),
  };
}

/**
 * @param {Date|string|number} eventTime
 * @param {number} windowSec
 * @returns {{ start: Date, end: Date }}
 */
function resolveBackfillTimeRange(eventTime, windowSec) {
  const center = new Date(eventTime);
  const baseMs = Number.isFinite(center.getTime())
    ? center.getTime()
    : Date.now();
  const win = normalizeEventBackfillWindowSec(windowSec);
  const start = new Date(baseMs - win * 1000);
  const endRaw = new Date(baseMs + win * 1000);
  const now = Date.now();
  const end = endRaw.getTime() > now ? new Date(now) : endRaw;
  return { start, end };
}

/** Asia/Taipei 偏移字串（AcsEvent／FCSearch／Traffic search 常用） */
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

function isSearchCompleteStatus(status) {
  const s = String(status || "").toUpperCase();
  return s === "OK" || s === "NO MATCH" || s === "NO MATCHES";
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
 * 多地點綁定同一設備時：任一開啟即啟用，秒數取最大
 * @param {Array<{ eventBackfillEnabled?: boolean, eventBackfillWindowSec?: number }|object>} configs
 */
function mergeEventBackfillPrefs(configs) {
  let enabled = false;
  let windowSec = DEFAULT_WINDOW_SEC;
  for (const raw of configs || []) {
    const fields = parseEventBackfillFields(raw || {});
    if (!fields.eventBackfillEnabled) continue;
    enabled = true;
    windowSec = Math.max(windowSec, fields.eventBackfillWindowSec);
  }
  return { enabled, windowSec };
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

module.exports = {
  DEFAULT_WINDOW_SEC,
  MIN_WINDOW_SEC,
  MAX_WINDOW_SEC,
  DEFAULT_DEBOUNCE_MS,
  normalizeEventBackfillEnabled,
  normalizeEventBackfillWindowSec,
  parseEventBackfillFields,
  resolveBackfillTimeRange,
  formatIsapiLocalDateTime,
  pickTag,
  pickBlocks,
  decodeXmlEntities,
  toIsapiUrlPath,
  responseBodyToString,
  isSearchCompleteStatus,
  isImageBuffer,
  downloadIsapiPicture,
  mergeEventBackfillPrefs,
  createDebouncedScheduler,
};
