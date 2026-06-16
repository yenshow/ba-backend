/**
 * 梯控樓層名稱設定（門參數）正規化與驗證
 */
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

const MAX_FLOOR_COUNT = 128;
const DEFAULT_FLOOR_START = 1;
const MIN_FLOOR_NUMBER = -9;
const MAX_FLOOR_NUMBER = 999;
const DOOR_NAME_MAX_LEN = 32;
const MIN_OPEN_DURATION = 1;
const MAX_OPEN_DURATION = 255;
const DEFAULT_OPEN_DURATION = 5;

const defaultSlotName = (slotIndex) => `${slotIndex + 1}F`;

const buildDefaultFloorNames = (count) =>
  Array.from({ length: count }, (_, i) => defaultSlotName(i));

/** 設備門序（1-based gatewayIndex）→ 樓層顯示名稱 */
const resolveElevatorFloorLabel = (gatewayIndex, floorNames) => {
  const idx = Number(gatewayIndex);
  if (!Number.isFinite(idx) || idx < 1) {
    return gatewayIndex != null ? String(gatewayIndex) : null;
  }
  const slotIndex = idx - 1;
  const name = Array.isArray(floorNames) ? floorNames[slotIndex]?.trim() : "";
  return name || defaultSlotName(slotIndex);
};

/** 事件紀錄樓層欄：將設備門序轉為設定的樓層名稱（支援合併後的「1、5」格式） */
const formatElevatorLogFloor = (floor, floorNames) => {
  if (floor == null || String(floor).trim() === "") return floor;
  const parts = String(floor)
    .split("、")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return floor;
  return parts
    .map((part) => {
      const n = Number(part);
      if (Number.isFinite(n) && n > 0) {
        return resolveElevatorFloorLabel(n, floorNames);
      }
      return part;
    })
    .join("、");
};

const mapElevatorLogsFloorDisplay = (logs, floorNames) =>
  (logs || []).map((log) => ({
    ...log,
    floor: formatElevatorLogFloor(log.floor, floorNames),
  }));

const normalizeFloorNumber = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < MIN_FLOOR_NUMBER || n > MAX_FLOOR_NUMBER) return null;
  return n;
};

const deriveFloorCount = (floorStart, floorEnd) => {
  if (!Number.isFinite(floorStart) || !Number.isFinite(floorEnd)) return null;
  if (floorEnd < floorStart) return null;
  const count = floorEnd - floorStart + 1;
  if (count < 1 || count > MAX_FLOOR_COUNT) return null;
  return count;
};

const resolveFloorRange = ({ floorCount, floorStart, floorEnd }) => {
  const normalizedCount = normalizeFloorCount(floorCount);
  if (normalizedCount == null) return null;

  const normalizedStart = normalizeFloorNumber(floorStart);
  const normalizedEnd = normalizeFloorNumber(floorEnd);

  if (normalizedStart != null && normalizedEnd != null) {
    const derivedCount = deriveFloorCount(normalizedStart, normalizedEnd);
    if (derivedCount == null) return null;
    return {
      floorStart: normalizedStart,
      floorEnd: normalizedEnd,
      floorCount: derivedCount,
    };
  }

  const start = normalizedStart ?? DEFAULT_FLOOR_START;
  const end = normalizedEnd ?? start + normalizedCount - 1;
  return { floorStart: start, floorEnd: end, floorCount: normalizedCount };
};

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
  const range = resolveFloorRange({
    floorCount: config.floorCount ?? config.floor_count,
    floorStart: config.floorStart ?? config.floor_start,
    floorEnd: config.floorEnd ?? config.floor_end,
  });

  const floorCount = range?.floorCount ?? null;
  const floorStart = range?.floorStart ?? null;
  const floorEnd = range?.floorEnd ?? null;

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

  return { floorCount, floorStart, floorEnd, floorNames, floorOpenDurations };
}

function validateElevatorFloorConfig(config = {}) {
  const deviceIds = normalizeDeviceIds(config);
  if (deviceIds.length === 0) {
    return {
      deviceIds,
      floorCount: null,
      floorStart: null,
      floorEnd: null,
      floorNames: [],
      floorOpenDurations: [],
    };
  }

  const { floorCount, floorStart, floorEnd, floorNames, floorOpenDurations } =
    normalizeElevatorFloorConfig(config);

  if (floorCount == null) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "請設定樓層範圍");
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
    floorStart,
    floorEnd,
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
  defaultFloorName: defaultSlotName,
  resolveElevatorFloorLabel,
  formatElevatorLogFloor,
  mapElevatorLogsFloorDisplay,
  normalizeElevatorFloorConfig,
  validateElevatorFloorConfig,
  collectElevatorFloorSyncTasks,
};
