/**
 * 電梯樓層偵測背景輪詢
 */
const elevatorRuntimeService = require("../elevator/elevatorRuntimeService");
const {
  getCachedLocations,
  setCachedLocations,
  invalidateLocationCache,
} = require("./elevatorLocationCache");
const logger = require("../../utils/logger").createLogger("ElevatorFloorMonitor");

const { ELEVATOR_POLL_IDLE_MS, ELEVATOR_POLL_MOVING_MS } = elevatorRuntimeService;

const getLocationService = () => require("../location/locationService");

async function getElevatorLocations() {
  const hit = getCachedLocations();
  if (hit) return hit;

  const result = await getLocationService().getZones({ locationType: "elevator" });
  const locations = (result.zones || []).flatMap((z) => z.locations || []);
  setCachedLocations(locations);
  return locations;
}

async function checkElevatorRuntime() {
  try {
    const locations = await getElevatorLocations();
    if (!locations.length) return { nextIntervalMs: ELEVATOR_POLL_IDLE_MS };

    await elevatorRuntimeService.pollAllElevatorLocations(locations);
    const nextIntervalMs = elevatorRuntimeService.hasAnyMovingElevator()
      ? ELEVATOR_POLL_MOVING_MS
      : ELEVATOR_POLL_IDLE_MS;
    return { nextIntervalMs };
  } catch (error) {
    logger.warn("電梯運行態輪詢失敗", { error: error?.message || String(error) });
    return { nextIntervalMs: ELEVATOR_POLL_IDLE_MS };
  }
}

module.exports = {
  checkElevatorRuntime,
  invalidateLocationCache,
};
