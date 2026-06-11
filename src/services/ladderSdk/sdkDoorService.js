/**
 * 梯控門參數（樓層名稱）— HCNetSDK Bridge
 */
const { invokeBridge } = require("./sdkBridgeClient");
const { getLadderDevice, toBridgeDevice } = require("./sdkLadderDeviceService");
const {
  collectElevatorFloorSyncTasks,
} = require("../elevator/elevatorFloorConfig");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrorMeta");

const syncFloorNames = async (deviceId, floors) => {
  const failures = [];

  for (let i = 0; i < floors.length; i += 1) {
    const doorIndex = i + 1;
    const floor = floors[i];
    try {
      const { credentials } = await getLadderDevice(deviceId);
      await invokeBridge({
        action: "door.set",
        device: toBridgeDevice(credentials),
        payload: {
          doorIndex,
          name: floor.name,
          openDuration: floor.openDuration,
        },
      });
    } catch (error) {
      failures.push({
        doorIndex,
        name: floor.name,
        openDuration: floor.openDuration ?? null,
        message: error?.message || String(error),
      });
    }
  }

  if (failures.length > 0) {
    throw createApiError(
      C.ELEVATOR_FLOOR_SYNC_FAILED,
      `樓層參數下發失敗（${failures.length}/${floors.length} 層）`,
      { details: { failures } },
    );
  }
};

const syncElevatorFloorsFromLocations = async (locations) => {
  const tasks = collectElevatorFloorSyncTasks(locations);
  for (const task of tasks) {
    await syncFloorNames(task.deviceId, task.floors);
  }
};

module.exports = {
  syncElevatorFloorsFromLocations,
};
