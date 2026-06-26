/**
 * 電梯運行態（DI 樓層、方向、呼梯目標）
 */
const websocketService = require("../websocket/websocketService");
const modbusBatchService = require("../devices/modbusBatchService");
const {
  resolveDefaultDisplayFloor,
  getElevatorConfigFromLocation,
} = require("./elevatorFloorModel");

const getDeviceService = () => require("../devices/deviceService");

const POLL_MOVING_TIMEOUT_MS = 60_000;
const ARRIVED_HOLD_MS = 1500;

/** @type {Map<number, object>} */
const runtimeByLocation = new Map();

const nowIso = () => new Date().toISOString();

const emptyRuntime = (locationId) => ({
  locationId: Number(locationId),
  currentFloor: null,
  direction: "idle",
  targetFloor: null,
  phase: "idle",
  updatedAt: nowIso(),
  _prevRank: null,
  _arrivedAt: null,
  _movingSince: null,
});

const getRuntime = (locationId) => {
  const id = Number(locationId);
  if (!runtimeByLocation.has(id)) {
    runtimeByLocation.set(id, emptyRuntime(id));
  }
  return runtimeByLocation.get(id);
};

const floorSnapshot = (index, floor) => ({
  index,
  label: floor.label,
  rank: floor.rank,
});

const resolveDirectionFromRanks = (prevRank, nextRank) => {
  if (prevRank == null || nextRank == null || prevRank === nextRank) return "idle";
  return nextRank > prevRank ? "up" : "down";
};

/**
 * 方向：有目標樓層時依 current→target；否則依輪詢 rank 變化
 */
function resolveRuntimeDirection(state, floors, currentFloor) {
  const cur = currentFloor ? floors[currentFloor.index - 1] : null;
  if (!cur) return "idle";

  if (state.targetFloor && state.phase === "moving") {
    const target = floors[state.targetFloor.index - 1];
    if (target) {
      if (cur.rank === target.rank) return "idle";
      return resolveDirectionFromRanks(cur.rank, target.rank);
    }
  }

  if (state._prevRank != null && cur.rank !== state._prevRank) {
    return resolveDirectionFromRanks(state._prevRank, cur.rank);
  }

  return "idle";
}

async function resolveDeviceModbusConfig(deviceId) {
  if (!deviceId) return null;
  try {
    const { device } = await getDeviceService().getDeviceById(Number(deviceId));
    const c = device?.config || {};
    if (!c.host || c.port == null) return null;
    return {
      host: c.host,
      port: Number(c.port),
      unitId: Number(c.unitId ?? 1),
    };
  } catch {
    return null;
  }
}

async function readDiscreteBits(deviceConfig, start, end) {
  if (!deviceConfig || start == null || end == null || end < start) {
    return new Map();
  }
  const length = end - start + 1;
  const results = await modbusBatchService.batchRead([
    {
      host: deviceConfig.host,
      port: deviceConfig.port,
      unitId: deviceConfig.unitId,
      registerType: "discrete",
      address: start,
      length,
      meta: { elevator: true },
    },
  ]);
  const first = results?.[0];
  if (!first || first.ok !== true || !Array.isArray(first.data)) {
    return new Map();
  }
  const map = new Map();
  for (let i = 0; i < first.data.length; i += 1) {
    map.set(start + i, Boolean(first.data[i]));
  }
  return map;
}

function resolveCurrentFloorFromBits(floors, bits) {
  const active = floors.filter((f) => f.diAddress != null && bits.get(f.diAddress));
  if (active.length === 1) {
    const idx = floors.indexOf(active[0]) + 1;
    return floorSnapshot(idx, active[0]);
  }
  return null;
}

function resolveDirectionToTarget(state, floors, targetRank) {
  const cur = state.currentFloor
    ? floors[state.currentFloor.index - 1]
    : null;
  if (cur) return resolveDirectionFromRanks(cur.rank, targetRank);
  if (state._prevRank != null) {
    return resolveDirectionFromRanks(state._prevRank, targetRank);
  }
  const fallback = resolveDefaultDisplayFloor(floors);
  const refRank =
    fallback != null ? floors[fallback.index - 1]?.rank : targetRank;
  return resolveDirectionFromRanks(refRank ?? targetRank, targetRank);
}

function runtimeSnapshot(state) {
  return JSON.stringify({
    currentFloor: state.currentFloor,
    direction: state.direction,
    targetFloor: state.targetFloor,
    phase: state.phase,
  });
}

function applyPhaseTransition(state, currentFloor, floors, direction) {
  const now = Date.now();

  if (
    state.targetFloor &&
    currentFloor &&
    state.targetFloor.index === currentFloor.index
  ) {
    state.phase = "arrived";
    state.direction = "idle";
    state._arrivedAt = now;
    state._movingSince = null;
    return;
  }

  if (state.phase === "arrived" && state._arrivedAt) {
    if (now - state._arrivedAt >= ARRIVED_HOLD_MS) {
      state.phase = "idle";
      state.targetFloor = null;
      state._arrivedAt = null;
      state._movingSince = null;
    }
    return;
  }

  if (state.phase === "moving" && state._movingSince) {
    if (now - state._movingSince >= POLL_MOVING_TIMEOUT_MS) {
      state.phase = "idle";
      state.targetFloor = null;
      state._movingSince = null;
      state.direction = "idle";
      return;
    }

    // 自然移動（無呼梯目標）：樓層 rank 已穩定 → 停止
    if (!state.targetFloor && currentFloor && direction === "idle") {
      const cur = floors[currentFloor.index - 1];
      if (cur && state._prevRank != null && cur.rank === state._prevRank) {
        state.phase = "idle";
        state._movingSince = null;
        state.direction = "idle";
        return;
      }
    }
    return;
  }

  if (
    state.phase === "idle" &&
    !state.targetFloor &&
    state._prevRank != null &&
    currentFloor
  ) {
    const cur = floors[currentFloor.index - 1];
    if (cur && cur.rank !== state._prevRank) {
      state.phase = "moving";
      state._movingSince = now;
    }
  }
}

function emitRuntimeUpdate(state) {
  const payload = {
    locationId: state.locationId,
    currentFloor: state.currentFloor,
    direction: state.direction,
    targetFloor: state.targetFloor,
    phase: state.phase,
    timestamp: state.updatedAt,
  };
  websocketService.emitElevatorRuntimeUpdate(payload);
}

async function pollLocationRuntime(location) {
  const locationId = Number(location.id);
  const config = getElevatorConfigFromLocation(location);
  const state = getRuntime(locationId);
  const floors = config.floors || [];

  if (!floors.length) {
    return getPublicRuntime(locationId);
  }

  let bits = new Map();
  if (config.floorDetection?.deviceId) {
    const deviceConfig = await resolveDeviceModbusConfig(
      config.floorDetection.deviceId,
    );
    const start = config.floorDetection.pointStart ?? 0;
    const end =
      config.floorDetection.pointEnd ??
      Math.max(...floors.map((f) => f.diAddress ?? start));
    bits = await readDiscreteBits(deviceConfig, start, end);
  }

  let currentFloor = resolveCurrentFloorFromBits(floors, bits);
  if (!currentFloor) {
    const fallback = resolveDefaultDisplayFloor(floors);
    if (fallback) {
      const floor = floors[fallback.index - 1];
      currentFloor = floorSnapshot(fallback.index, floor);
    }
  }

  const direction = resolveRuntimeDirection(state, floors, currentFloor);

  const prevSnapshot = runtimeSnapshot(state);

  state.currentFloor = currentFloor;
  state.direction = direction;
  state.updatedAt = nowIso();

  applyPhaseTransition(state, currentFloor, floors, direction);

  if (currentFloor) {
    const cur = floors[currentFloor.index - 1];
    state._prevRank = cur?.rank ?? null;
  }

  if (prevSnapshot !== runtimeSnapshot(state)) {
    emitRuntimeUpdate(state);
  }

  return getPublicRuntime(locationId);
}

function getPublicRuntime(locationId) {
  const state = getRuntime(locationId);
  return {
    currentFloor: state.currentFloor,
    direction: state.direction,
    targetFloor: state.targetFloor,
    phase: state.phase,
    updatedAt: state.updatedAt,
  };
}

function notifyCallElevator(locationId, targetLogicalIndex, config) {
  const state = getRuntime(locationId);
  const floors = config.floors || [];
  const slot = floors[targetLogicalIndex - 1];
  if (!slot) return getPublicRuntime(locationId);

  state.targetFloor = floorSnapshot(targetLogicalIndex, slot);
  state.phase = "moving";
  state._movingSince = Date.now();
  state.updatedAt = nowIso();
  state.direction = resolveDirectionToTarget(state, floors, slot.rank);

  emitRuntimeUpdate(state);
  return getPublicRuntime(locationId);
}

async function pollAllElevatorLocations(getLocations) {
  const locations = await getLocations();
  const results = [];
  for (const loc of locations) {
    try {
      const live = await pollLocationRuntime(loc);
      results.push({ locationId: Number(loc.id), live });
    } catch {
      results.push({
        locationId: Number(loc.id),
        live: getPublicRuntime(Number(loc.id)),
      });
    }
  }
  return results;
}

module.exports = {
  getRuntime,
  getPublicRuntime,
  pollLocationRuntime,
  pollAllElevatorLocations,
  notifyCallElevator,
};
