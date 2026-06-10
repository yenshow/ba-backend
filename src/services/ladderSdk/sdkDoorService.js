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

const syncFloorNames = async (deviceId, floorNames) => {
  const failures = [];

  for (let i = 0; i < floorNames.length; i += 1) {
    const doorIndex = i + 1;
    try {
      const { credentials } = await getLadderDevice(deviceId);
      await invokeBridge({
        action: "door.set",
        device: toBridgeDevice(credentials),
        payload: { doorIndex, name: floorNames[i] },
      });
    } catch (error) {
      failures.push({
        doorIndex,
        name: floorNames[i],
        message: error?.message || String(error),
      });
    }
  }

  if (failures.length > 0) {
    throw createApiError(
      C.ELEVATOR_FLOOR_SYNC_FAILED,
      `樓層名稱下發失敗（${failures.length}/${floorNames.length} 層）`,
      { details: { failures } },
    );
  }
};

const syncElevatorFloorsFromLocations = async (locations) => {
  const tasks = collectElevatorFloorSyncTasks(locations);
  for (const task of tasks) {
    await syncFloorNames(task.deviceId, task.floorNames);
  }
};

module.exports = {
  syncElevatorFloorsFromLocations,
};
