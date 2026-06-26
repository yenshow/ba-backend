/**
 * 電梯樓層偵測背景輪詢
 */
const locationService = require("../location/locationService");
const elevatorRuntimeService = require("../elevator/elevatorRuntimeService");
const logger = require("../../utils/logger").createLogger("ElevatorFloorMonitor");

const BASE_INTERVAL_MS = 2000;

let cachedLocations = [];
let lastLocationFetch = 0;
const LOCATION_CACHE_MS = 30_000;

async function getElevatorLocations() {
  const now = Date.now();
  if (now - lastLocationFetch < LOCATION_CACHE_MS && cachedLocations.length) {
    return cachedLocations;
  }
  const result = await locationService.getZones({ locationType: "elevator" });
  cachedLocations = (result.zones || []).flatMap((z) => z.locations || []);
  lastLocationFetch = now;
  return cachedLocations;
}

async function checkElevatorRuntime() {
  try {
    const locations = await getElevatorLocations();
    if (!locations.length) return { nextIntervalMs: BASE_INTERVAL_MS };

    await elevatorRuntimeService.pollAllElevatorLocations(async () => locations);
    return { nextIntervalMs: BASE_INTERVAL_MS };
  } catch (error) {
    logger.warn("電梯運行態輪詢失敗", { error: error?.message || String(error) });
    return { nextIntervalMs: BASE_INTERVAL_MS };
  }
}

function invalidateLocationCache() {
  lastLocationFetch = 0;
  cachedLocations = [];
}

module.exports = {
  checkElevatorRuntime,
  invalidateLocationCache,
  BASE_INTERVAL_MS,
};
