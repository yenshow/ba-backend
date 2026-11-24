/**
 * 快照 REST 解析：預設讀 monitoringSnapshotCache。
 * Query `?noCache=true` 略過記憶體快取、觸發 Modbus 重讀（與 HTTP middleware `disableHttpCache` 無關）。
 */

const monitoringSnapshotCache = require("./monitoringSnapshotCache");

const isTruthyQuery = (value) => {
  if (value === true || value === 1) return true;
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return s === "1" || s === "true" || s === "yes";
};

const parseNoCache = (query = {}) =>
  isTruthyQuery(query.noCache) || isTruthyQuery(query.force);

/**
 * @param {string} systemKey
 * @param {{ getStatusSnapshot: Function }} statusService
 * @param {{ zoneIds?: string[], noCache?: boolean, force?: boolean }} query
 */
async function resolveStatusSnapshot(systemKey, statusService, query = {}) {
  const zoneIds = query.zoneIds;
  const noCache = parseNoCache(query);

  if (!noCache) {
    const cached = monitoringSnapshotCache.getSnapshot(systemKey, { zoneIds });
    if (cached) {
      return cached;
    }
  }

  const version = monitoringSnapshotCache.beginSnapshotRead();
  const result = await statusService.getStatusSnapshot({ zoneIds });
  monitoringSnapshotCache.setSnapshot(systemKey, result, { version, zoneIds });
  const entry = monitoringSnapshotCache.getSnapshot(systemKey, { zoneIds });
  return {
    items: entry?.items ?? result.items ?? [],
    fetchedAt: entry?.fetchedAt ?? new Date().toISOString(),
    fromCache: false,
  };
}

/**
 * @param {string} systemKey
 * @param {{ getZoneStatusSnapshot: Function }} statusService
 * @param {number|string} zoneId
 * @param {{ noCache?: boolean, force?: boolean }} query
 */
async function resolveZoneStatusSnapshot(
  systemKey,
  statusService,
  zoneId,
  query = {},
) {
  const numericZoneId = parseInt(String(zoneId), 10);
  const noCache = parseNoCache(query);

  if (!noCache) {
    const cached = monitoringSnapshotCache.getZoneSnapshot(systemKey, numericZoneId);
    if (cached) {
      return { ...cached, zoneId: String(zoneId) };
    }
  }

  const version = monitoringSnapshotCache.beginSnapshotRead();
  const result = await statusService.getZoneStatusSnapshot(
    numericZoneId,
    {},
  );
  if (Array.isArray(result?.items)) {
    monitoringSnapshotCache.setSnapshot(systemKey, result, {
      version,
      zoneIds: [numericZoneId],
    });
  }
  const entry = monitoringSnapshotCache.getZoneSnapshot(systemKey, numericZoneId);
  return {
    zoneId: String(zoneId),
    items: entry?.items ?? result.items ?? [],
    fetchedAt: entry?.fetchedAt ?? new Date().toISOString(),
    fromCache: false,
  };
}

module.exports = {
  resolveStatusSnapshot,
  resolveZoneStatusSnapshot,
};
