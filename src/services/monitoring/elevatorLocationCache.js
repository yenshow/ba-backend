/**
 * 電梯地點列表快取（供背景輪詢使用，獨立模組以避免 location ↔ monitor 循環依賴）
 */
const { ELEVATOR_LOCATION_CACHE_MS: LOCATION_CACHE_MS } = require("../../config/realtimeTiming");

let cachedLocations = [];
let lastLocationFetch = 0;

const getCachedLocations = () => {
  const now = Date.now();
  if (now - lastLocationFetch < LOCATION_CACHE_MS && cachedLocations.length) {
    return cachedLocations;
  }
  return null;
};

const setCachedLocations = (locations) => {
  cachedLocations = locations;
  lastLocationFetch = Date.now();
};

const invalidateLocationCache = () => {
  lastLocationFetch = 0;
  cachedLocations = [];
};

module.exports = {
  LOCATION_CACHE_MS,
  getCachedLocations,
  setCachedLocations,
  invalidateLocationCache,
};
