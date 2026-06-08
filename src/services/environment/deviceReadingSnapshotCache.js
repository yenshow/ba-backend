/**
 * 依 deviceId 快取環境感測器最新讀數（由 environmentMonitor 寫入，multimedia 等消費）。
 */

const STALE_MS = 10 * 60 * 1000;
const byDeviceId = new Map();

const isFresh = (entry) => {
  if (!entry) return false;
  const anchor = Date.parse(entry.recordedAt) || entry.updatedAt || 0;
  return anchor > 0 && Date.now() - anchor < STALE_MS;
};

const setDeviceReading = (deviceId, payload) => {
  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) return;
  byDeviceId.set(id, {
    recordedAt:
      typeof payload?.recordedAt === "string" && payload.recordedAt
        ? payload.recordedAt
        : new Date().toISOString(),
    data:
      payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? payload.data
        : {},
    status: payload?.status === "offline" ? "offline" : "online",
    updatedAt: Date.now(),
  });
};

const getDeviceReadings = (deviceIds) => {
  const out = new Map();
  for (const rawId of deviceIds || []) {
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) continue;
    const hit = byDeviceId.get(id);
    if (!isFresh(hit)) {
      if (hit) byDeviceId.delete(id);
      continue;
    }
    out.set(id, hit);
  }
  return out;
};

module.exports = {
  setDeviceReading,
  getDeviceReadings,
};
