/**
 * 電梯運行態（DI 樓層、方向、呼梯目標）
 */
const websocketService = require("../websocket/websocketService");
const logger = require("../../utils/logger").createLogger("ElevatorRuntime");
const {
  resolveDeviceConfig,
  readDiscreteBitRange,
} = require("../snapshotStatus/modbusSnapshotHelpers");
const {
  resolveDefaultDisplayFloor,
  getElevatorConfigFromLocation,
} = require("./elevatorFloorModel");

const {
  ELEVATOR_POLL_IDLE_MS,
  ELEVATOR_POLL_MOVING_MS,
  ELEVATOR_ARRIVED_HOLD_MS: ARRIVED_HOLD_MS,
  ELEVATOR_MOVING_TIMEOUT_MS: POLL_MOVING_TIMEOUT_MS,
} = require("../../config/realtimeTiming");
const READ_FAILED = Object.freeze({ bits: new Map(), readOk: false });

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
  floorDetection: null,
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

async function readFloorDetectionBits(floorDetection, floors) {
  if (!floorDetection?.deviceId) return READ_FAILED;
  const deviceConfig = await resolveDeviceConfig(floorDetection.deviceId);
  const start = floorDetection.pointStart ?? 0;
  const end =
    floorDetection.pointEnd ??
    Math.max(...floors.map((f) => f.diAddress ?? start));
  return readDiscreteBitRange(deviceConfig, start, end, { noCache: true });
}

function resolveCurrentFloorFromBits(floors, bits, locationId = null) {
  const active = floors.filter((f) => {
    const addr = Number(f.diAddress);
    return Number.isFinite(addr) && bits.get(addr) === true;
  });
  if (!active.length) return null;
  const pick = [...active].sort((a, b) => a.rank - b.rank)[0];
  if (active.length > 1) {
    logger.warn("電梯 DI 多個樓層同時 active", {
      locationId,
      ranks: active.map((f) => f.rank),
      pickedRank: pick.rank,
    });
  }
  return floorSnapshot(floors.indexOf(pick) + 1, pick);
}

/**
 * currentFloor 僅來自 DI；無 active bit 或讀取失敗時維持上一樓層，僅初次無樓層才預設 1F。
 */
function resolveFloorFromDetection(diReadOk, floors, bits, state) {
  const matched = resolveCurrentFloorFromBits(floors, bits, state.locationId);
  if (matched) {
    return { currentFloor: matched, floorDetection: { readOk: diReadOk } };
  }
  if (state.currentFloor) {
    return { currentFloor: state.currentFloor, floorDetection: { readOk: diReadOk } };
  }
  const fallback = resolveDefaultDisplayFloor(floors);
  if (!fallback) {
    return { currentFloor: null, floorDetection: { readOk: diReadOk } };
  }
  const floor = floors[fallback.index - 1];
  return {
    currentFloor: floorSnapshot(fallback.index, floor),
    floorDetection: { readOk: diReadOk },
  };
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
    floorDetection: state.floorDetection,
  });
}

/**
 * phase：moving = 呼梯目標未抵達或自然 rank 變化中；arrived = DI 與 target 一致；idle = 靜止。
 * direction：有 target 且 moving 時依 current→target rank；否則依輪詢 rank 差。
 */
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

function toPublicRuntime(state) {
  return {
    currentFloor: state.currentFloor,
    direction: state.direction,
    targetFloor: state.targetFloor,
    phase: state.phase,
    floorDetection: state.floorDetection,
    updatedAt: state.updatedAt,
  };
}

function emitRuntimeUpdate(state) {
  websocketService.emitElevatorRuntimeUpdate({
    locationId: state.locationId,
    ...toPublicRuntime(state),
    timestamp: state.updatedAt,
  });
}

async function pollLocationRuntime(location) {
  const locationId = Number(location.id);
  const config = getElevatorConfigFromLocation(location);
  const state = getRuntime(locationId);
  const floors = config.floors || [];

  if (!floors.length) {
    return getPublicRuntime(locationId);
  }

  const { bits, readOk: diReadOk } = await readFloorDetectionBits(
    config.floorDetection,
    floors,
  );
  const { currentFloor, floorDetection } = resolveFloorFromDetection(
    diReadOk,
    floors,
    bits,
    state,
  );

  const direction = resolveRuntimeDirection(state, floors, currentFloor);
  const prevSnapshot = runtimeSnapshot(state);

  state.currentFloor = currentFloor;
  state.floorDetection = floorDetection;
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
  return toPublicRuntime(getRuntime(locationId));
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

function hasAnyMovingElevator() {
  for (const state of runtimeByLocation.values()) {
    if (state.phase === "moving" || state.phase === "arrived") return true;
  }
  return false;
}

async function pollAllElevatorLocations(locations) {
  for (const loc of locations) {
    try {
      await pollLocationRuntime(loc);
    } catch {
      /* 保留記憶體快取 */
    }
  }
}

module.exports = {
  ELEVATOR_POLL_IDLE_MS,
  ELEVATOR_POLL_MOVING_MS,
  getRuntime,
  getPublicRuntime,
  pollLocationRuntime,
  pollAllElevatorLocations,
  notifyCallElevator,
  hasAnyMovingElevator,
};
