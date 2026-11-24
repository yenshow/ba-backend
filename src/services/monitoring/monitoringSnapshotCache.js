/**
 * 監控快照記憶體快取（Push-First SSOT）
 * 背景 monitor 寫入；REST /status 預設讀取；WS diff 推播依此比對。
 */

const cache = new Map();
let readVersion = 0;

// 依開始讀取的順序判定新舊，避免慢回應蓋掉後發的讀取。
const beginSnapshotRead = () => ++readVersion;

const getSystemId = (item) => item?.systemId ?? item?.system_id ?? null;

const itemSignature = (item) => {
  const raw =
    item?.raw && typeof item.raw === "object"
      ? JSON.stringify(item.raw)
      : "";
  const err = item?.error != null ? String(item.error) : "";
  return `${getSystemId(item)}|${item?.uiStatus ?? ""}|${err}|${raw}`;
};

const getZoneId = (item) => String(item?.zoneId ?? "");

/**
 * @param {string} systemKey
 * @param {{ items?: object[] }} payload
 * @param {{ version: number, zoneIds?: (number|string)[] }} options
 */
function setSnapshot(systemKey, payload, { version, zoneIds }) {
  if (!systemKey) return false;
  const state = cache.get(systemKey) ?? {
    full: null,
    zones: new Map(),
    mergedItems: null,
  };
  const existingFullVersion = state.full?.version ?? 0;
  if (version <= existingFullVersion) return false;

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const entry = { items, version, fetchedAt: new Date().toISOString() };
  if (zoneIds?.length) {
    const byZone = new Map(zoneIds.map((id) => [String(id), []]));
    for (const item of items) byZone.get(getZoneId(item))?.push(item);
    for (const [id, zoneItems] of byZone) {
      if ((state.zones.get(id)?.version ?? 0) < version) {
        state.zones.set(id, { ...entry, items: zoneItems });
      }
    }
  } else {
    state.full = entry;
    for (const [id, zone] of state.zones) {
      if (zone.version <= version) state.zones.delete(id);
    }
  }
  state.mergedItems = null;
  cache.set(systemKey, state);
  return true;
}

/**
 * @param {string} systemKey
 * @param {{ zoneIds?: (number|string)[] }} [options]
 * @returns {{ items: object[], fetchedAt: string, fromCache: true } | null}
 */
function getSnapshot(systemKey, options = {}) {
  const state = cache.get(systemKey);
  if (!state) return null;
  const { full, zones } = state;
  if (!options.zoneIds?.length) {
    if (!full) return null;
    if (zones.size > 0 && !state.mergedItems) {
      state.mergedItems = full.items.filter((item) => !zones.has(getZoneId(item)));
      for (const zone of zones.values()) {
        for (const item of zone.items) state.mergedItems.push(item);
      }
    }
    return {
      items: state.mergedItems ?? full.items,
      fetchedAt: full.fetchedAt,
      fromCache: true,
    };
  }

  const requested = new Set(options.zoneIds.map(String));
  const scoped = [];
  let oldest = null;
  for (const id of requested) {
    const zone = zones.get(id);
    const entry = zone ?? full;
    if (!entry) return null;
    if (!oldest || entry.version < oldest.version) oldest = entry;
    if (zone) {
      requested.delete(id);
      scoped.push(zone);
    }
  }

  const items = requested.size
    ? full.items.filter((item) => requested.has(getZoneId(item)))
    : [];
  for (const entry of scoped) {
    for (const item of entry.items) items.push(item);
  }
  return { items, fetchedAt: oldest.fetchedAt, fromCache: true };
}

/**
 * @param {object[]} previousItems
 * @param {object[]} nextItems
 * @returns {object[]} 變更的 items（供 WS 推播）
 */
function diffChangedItems(previousItems, nextItems) {
  const prevMap = new Map();
  for (const item of previousItems) {
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
  const entry = getSnapshot(systemKey, { zoneIds: [zoneId] });
  return entry && { zoneId: String(zoneId), ...entry };
}

function getFullSnapshotAges() {
  const now = Date.now();
  const snapshots = [];
  for (const [systemKey, { full }] of cache) {
    if (!full) continue;
    snapshots.push({
      systemKey,
      fetchedAt: full.fetchedAt,
      ageMs: Math.max(0, now - Date.parse(full.fetchedAt)),
    });
  }
  return snapshots;
}

module.exports = {
  beginSnapshotRead,
  setSnapshot,
  getSnapshot,
  getZoneSnapshot,
  getFullSnapshotAges,
  diffChangedItems,
};
