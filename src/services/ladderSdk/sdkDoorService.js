/**
 * 梯控門參數（樓層名稱）— HCNetSDK Bridge
 */
const { invokeBridge } = require("./sdkBridgeClient");
const { getLadderDevice, toBridgeDevice } = require("./sdkLadderDeviceService");
const {
  collectElevatorFloorSyncTasks,
} = require("../elevator/elevatorFloorModel");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");

const syncFloorNames = async (deviceId, floors, doorIndexes) => {
  const failures = [];
  const { credentials } = await getLadderDevice(deviceId);
  const bridgeDevice = toBridgeDevice(credentials);

  for (let i = 0; i < floors.length; i += 1) {
    const doorIndex =
      Array.isArray(doorIndexes) && doorIndexes[i] != null
        ? Number(doorIndexes[i])
        : i + 1;
    const floor = floors[i];
    try {
      await invokeBridge({
        action: "door.set",
        device: bridgeDevice,
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
    await syncFloorNames(task.deviceId, task.floors, task.doorIndexes);
  }
};

module.exports = {
  syncElevatorFloorsFromLocations,
};
