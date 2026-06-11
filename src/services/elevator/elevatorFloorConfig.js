/**
 * 梯控樓層名稱設定（門參數）正規化與驗證
 */
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

const MAX_FLOOR_COUNT = 128;
const DOOR_NAME_MAX_LEN = 32;
const MIN_OPEN_DURATION = 1;
const MAX_OPEN_DURATION = 255;
const DEFAULT_OPEN_DURATION = 5;

const defaultFloorName = (index) =>
  `Floor ${String(index).padStart(2, "0")}`;

const buildDefaultFloorNames = (count) =>
  Array.from({ length: count }, (_, i) => defaultFloorName(i + 1));

const normalizeFloorCount = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.trunc(n), MAX_FLOOR_COUNT);
};

const normalizeOpenDuration = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const duration = Math.trunc(n);
  if (duration < MIN_OPEN_DURATION || duration > MAX_OPEN_DURATION) {
    return null;
  }
  return duration;
};

const normalizeFloorOpenDurations = (config = {}, floorCount) => {
  const raw = config.floorOpenDurations ?? config.floor_open_durations;
  const existing = Array.isArray(raw) ? raw : [];
  return Array.from({ length: floorCount }, (_, i) => {
    const duration = normalizeOpenDuration(existing[i]);
    return duration ?? DEFAULT_OPEN_DURATION;
  });
};

const pickElevatorConfig = (location) => {
  const sys = (location.systems || []).find((s) => s.systemType === "elevator");
  if (sys?.config) return sys.config;
  if (
    location.config &&
    (location.locationType === "elevator" || location.location_type === "elevator")
  ) {
    return location.config;
  }
  return null;
};

const normalizeDeviceIds = (config = {}) => {
  const raw = config.deviceIds ?? config.device_ids;
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
};

function normalizeElevatorFloorConfig(config = {}) {
  const floorCount = normalizeFloorCount(
    config.floorCount ?? config.floor_count,
  );
  let floorNames = Array.isArray(config.floorNames ?? config.floor_names)
    ? (config.floorNames ?? config.floor_names).map((item) =>
        String(item ?? "").trim(),
      )
    : [];

  if (floorCount != null && floorNames.length === 0) {
    floorNames = buildDefaultFloorNames(floorCount);
  }
  if (floorCount != null && floorNames.length > floorCount) {
    floorNames = floorNames.slice(0, floorCount);
  }

  const floorOpenDurations =
    floorCount != null ? normalizeFloorOpenDurations(config, floorCount) : [];

  return { floorCount, floorNames, floorOpenDurations };
}

function validateElevatorFloorConfig(config = {}) {
  const deviceIds = normalizeDeviceIds(config);
  if (deviceIds.length === 0) {
    return { deviceIds, floorCount: null, floorNames: [], floorOpenDurations: [] };
  }

  const { floorCount, floorNames, floorOpenDurations } =
    normalizeElevatorFloorConfig(config);

  if (floorCount == null) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "請設定樓層數量");
  }
  if (floorNames.length !== floorCount) {
    throwApiError(
      C.ELEVATOR_VALIDATION_FAILED,
      `樓層名稱數量（${floorNames.length}）須與樓層數量（${floorCount}）一致`,
    );
  }

  const validatedNames = floorNames.map((name, i) => {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `第 ${i + 1} 層樓層名稱不可為空`,
      );
    }
    if (trimmed.length > DOOR_NAME_MAX_LEN) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `第 ${i + 1} 層樓層名稱不可超過 ${DOOR_NAME_MAX_LEN} 字元`,
      );
    }
    return trimmed;
  });

  const validatedOpenDurations = floorOpenDurations.map((duration, i) => {
    const normalized = normalizeOpenDuration(duration);
    if (normalized == null) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `第 ${i + 1} 層繼電器動作時間須為 ${MIN_OPEN_DURATION}-${MAX_OPEN_DURATION} 秒`,
      );
    }
    return normalized;
  });

  return {
    deviceIds,
    floorCount,
    floorNames: validatedNames,
    floorOpenDurations: validatedOpenDurations,
  };
}

function collectElevatorFloorSyncTasks(locations) {
  const tasks = [];
  for (const location of locations || []) {
    const config = pickElevatorConfig(location);
    if (!config) continue;

    const validated = validateElevatorFloorConfig(config);
    if (!validated.deviceIds.length || !validated.floorCount) continue;

    tasks.push({
      deviceId: validated.deviceIds[0],
      floors: validated.floorNames.map((name, index) => ({
        name,
        openDuration: validated.floorOpenDurations[index],
      })),
    });
  }
  return tasks;
}

module.exports = {
  normalizeElevatorFloorConfig,
  validateElevatorFloorConfig,
  collectElevatorFloorSyncTasks,
};
