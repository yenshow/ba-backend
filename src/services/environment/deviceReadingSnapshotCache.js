/**
 * 依 deviceId 快取環境感測器最新讀數（由 environmentMonitor 寫入，multimedia 等消費）。
 */

const {
  ENVIRONMENT_READING_STALE_MS: STALE_MS,
} = require("../../config/realtimeTiming");

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

/** 取快取（含可能已 stale；供 Monitor 做 WS diff，不刪除） */
const peekDeviceReading = (deviceId) => {
  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return byDeviceId.get(id) || null;
};

/**
 * 讀數／連線狀態是否相對上次快取有變（不含 recordedAt）
 * @param {number} deviceId
 * @param {{ data?: object, status?: string }} next
 */
const hasReadingChanged = (deviceId, next) => {
  const prev = peekDeviceReading(deviceId);
  if (!prev) return true;
  const nextStatus = next?.status === "offline" ? "offline" : "online";
  if (prev.status !== nextStatus) return true;
  const nextData =
    next?.data && typeof next.data === "object" && !Array.isArray(next.data)
      ? next.data
      : {};
  return JSON.stringify(prev.data) !== JSON.stringify(nextData);
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
  hasReadingChanged,
  getDeviceReadings,
};
