/**
 * 監控快照記憶體快取（Push-First SSOT）
 * 背景 monitor 寫入；REST /status 預設讀取；WS diff 推播依此比對。
 */

/** @type {Map<string, { items: object[], fetchedAt: string }>} */
const cache = new Map();

const getSystemId = (item) => item?.systemId ?? item?.system_id ?? null;

const itemSignature = (item) => {
  const raw =
    item?.raw && typeof item.raw === "object"
      ? JSON.stringify(item.raw)
      : "";
  const err = item?.error != null ? String(item.error) : "";
  return `${getSystemId(item)}|${item?.uiStatus ?? ""}|${err}|${raw}`;
};

const filterItemsByZoneIds = (items, zoneIds) => {
  if (!Array.isArray(items)) return [];
  if (!zoneIds?.length) return items;
  const want = new Set(zoneIds.map((id) => String(id)));
  return items.filter((item) => want.has(String(item?.zoneId ?? "")));
};

const filterItemsByZoneId = (items, zoneId) =>
  filterItemsByZoneIds(items, [zoneId]);

/**
 * @param {string} systemKey
 * @param {{ items?: object[] }} payload
 */
function setSnapshot(systemKey, payload) {
  if (!systemKey) return;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  cache.set(systemKey, {
    items,
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * @param {string} systemKey
 * @param {{ zoneIds?: string[] }} [options]
 * @returns {{ items: object[], fetchedAt: string, fromCache: true } | null}
 */
function getSnapshot(systemKey, options = {}) {
  const entry = cache.get(systemKey);
  if (!entry) return null;
  const items = filterItemsByZoneIds(entry.items, options.zoneIds);
  return {
    items,
    fetchedAt: entry.fetchedAt,
    fromCache: true,
  };
}

/**
 * @param {string} systemKey
 * @param {object[]} nextItems
 * @returns {object[]} 變更的 items（供 WS 推播）
 */
function diffChangedItems(systemKey, nextItems) {
  const prev = cache.get(systemKey)?.items || [];
  const prevMap = new Map();
  for (const item of prev) {
    const sid = getSystemId(item);
    if (sid != null) prevMap.set(String(sid), itemSignature(item));
  }

  const changed = [];
  for (const item of nextItems || []) {
    const sid = getSystemId(item);
    if (sid == null) continue;
    const sig = itemSignature(item);
    if (prevMap.get(String(sid)) !== sig) {
      changed.push(item);
    }
  }
  return changed;
}

function getZoneSnapshot(systemKey, zoneId) {
  const entry = cache.get(systemKey);
  if (!entry) return null;
  const items = filterItemsByZoneId(entry.items, zoneId);
  return {
    zoneId: String(zoneId),
    items,
    fetchedAt: entry.fetchedAt,
    fromCache: true,
  };
}

module.exports = {
  setSnapshot,
  getSnapshot,
  getZoneSnapshot,
  diffChangedItems,
  /** @internal 供 monitor 判斷是否為首次寫入（避免啟動時全量 WS） */
  hasSnapshot: (systemKey) => cache.has(systemKey),
};
