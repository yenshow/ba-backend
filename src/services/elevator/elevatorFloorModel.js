/**
 * 電梯邏輯樓層模型（SSOT）
 * - 平台先定義 floors[]，再綁定梯控／呼梯／DI 點位
 */
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

const MAX_FLOOR_COUNT = 128;
const MIN_OPEN_DURATION = 1;
const MAX_OPEN_DURATION = 255;
const DEFAULT_OPEN_DURATION = 5;
const DOOR_NAME_MAX_LEN = 32;
const MAX_PANEL_COLUMNS = 8;
const MAX_PANEL_ROWS = 32;
/** 面板固定列數（與前端 PANEL_ROW_COUNT 一致） */
const PANEL_ROW_COUNT = 6;
const DEFAULT_CALL_COMMAND_TYPE = "visitor";

const normalizeCallCommandType = () => DEFAULT_CALL_COMMAND_TYPE;

const normalizePositiveInt = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
};

const normalizeDeviceId = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const normalizeOpenDuration = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const duration = Math.trunc(n);
  if (duration < MIN_OPEN_DURATION || duration > MAX_OPEN_DURATION) return null;
  return duration;
};

const pickDeviceRole = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const deviceId = normalizeDeviceId(raw.deviceId ?? raw.device_id);
  if (!deviceId) return null;
  const pointStart = normalizePositiveInt(raw.pointStart ?? raw.point_start);
  const pointEnd = normalizePositiveInt(raw.pointEnd ?? raw.point_end);
  return {
    deviceId,
    pointStart: pointStart ?? undefined,
    pointEnd: pointEnd ?? undefined,
  };
};

const normalizePanel = (raw, floorCount) => {
  const columns =
    normalizePositiveInt(raw?.columns) ??
    Math.max(1, Math.ceil(Math.max(floorCount, 1) / PANEL_ROW_COUNT));
  const rows = normalizePositiveInt(raw?.rows) ?? PANEL_ROW_COUNT;
  return {
    columns: Math.min(Math.max(columns, 1), MAX_PANEL_COLUMNS),
    rows: Math.min(Math.max(rows, 1), MAX_PANEL_ROWS),
  };
};

const normalizeFloorInput = (raw, index) => {
  if (!raw || typeof raw !== "object") return null;
  const label = String(raw.label ?? "").trim();
  if (!label) return null;
  const name = String(raw.name ?? "").trim();
  const rank = normalizePositiveInt(raw.rank);
  const panelCol = normalizePositiveInt(raw.panelCol ?? raw.panel_col);
  const panelRow = normalizePositiveInt(raw.panelRow ?? raw.panel_row);
  const ladderGateway = normalizePositiveInt(
    raw.ladderGateway ?? raw.ladder_gateway,
  );
  const callGateway = normalizePositiveInt(raw.callGateway ?? raw.call_gateway);
  const diAddress = normalizePositiveInt(raw.diAddress ?? raw.di_address);
  const openDuration =
    normalizeOpenDuration(raw.openDuration ?? raw.open_duration) ??
    DEFAULT_OPEN_DURATION;
  return {
    label,
    name: name || undefined,
    rank: rank ?? index,
    panelCol: panelCol ?? 0,
    panelRow: panelRow ?? 0,
    openDuration,
    ladderGateway: ladderGateway ?? null,
    callGateway: callGateway ?? null,
    diAddress: diAddress ?? null,
    bindingOverridden: Boolean(raw.bindingOverridden ?? raw.binding_overridden),
  };
};

function normalizeElevatorLocationConfig(config = {}) {
  const floorsRaw = Array.isArray(config.floors) ? config.floors : [];
  const floors = floorsRaw
    .map((f, i) => normalizeFloorInput(f, i))
    .filter(Boolean);

  const panel = normalizePanel(config.panel, floors.length);
  const ladderDevice = pickDeviceRole(
    config.ladderDevice ?? config.ladder_device,
  );
  const callDevice = pickDeviceRole(config.callDevice ?? config.call_device);
  const floorDetection = pickDeviceRole(
    config.floorDetection ?? config.floor_detection,
  );

  const accessDeviceIds = Array.isArray(
    config.accessDeviceIds ?? config.access_device_ids,
  )
    ? (config.accessDeviceIds ?? config.access_device_ids)
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];

  return {
    panel,
    floors,
    ladderDevice,
    callDevice,
    floorDetection,
    accessDeviceIds,
    callCommandType: normalizeCallCommandType(
      config.callCommandType ?? config.call_command_type,
    ),
    logDisplayColumns: config.logDisplayColumns ?? config.log_display_columns,
  };
}

const isPointInRange = (point, role) => {
  if (point == null) return true;
  if (!role) return false;
  const start = role.pointStart;
  const end = role.pointEnd;
  if (start == null || end == null) return true;
  return point >= start && point <= end;
};

const autoFillBindings = (floors, roles) => {
  return floors.map((floor, index) => {
    const next = { ...floor };
    if (next.ladderGateway == null && roles.ladderDevice?.pointStart != null) {
      next.ladderGateway = roles.ladderDevice.pointStart + index;
    }
    if (next.callGateway == null && roles.callDevice?.pointStart != null) {
      next.callGateway = roles.callDevice.pointStart + index;
    }
    if (next.diAddress == null && roles.floorDetection?.pointStart != null) {
      next.diAddress = roles.floorDetection.pointStart + index;
    }
    return next;
  });
};

function validateElevatorLocationConfig(config = {}) {
  const normalized = normalizeElevatorLocationConfig(config);

  if (!normalized.ladderDevice?.deviceId) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "請選擇梯控設備");
  }

  if (!normalized.callDevice?.deviceId) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "請選擇呼梯設備");
  }

  if (!normalized.floorDetection?.deviceId) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "請選擇樓層偵測設備");
  }

  if (!normalized.accessDeviceIds.length) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "請至少選擇一台門禁設備");
  }

  if (!normalized.floors.length) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "請至少設定一個邏輯樓層");
  }
  if (normalized.floors.length > MAX_FLOOR_COUNT) {
    throwApiError(
      C.ELEVATOR_VALIDATION_FAILED,
      `樓層數量不可超過 ${MAX_FLOOR_COUNT}`,
    );
  }

  const panelKeys = new Set();
  const ranks = new Set();
  const validatedFloors = normalized.floors.map((floor, i) => {
    const label = String(floor.label ?? "").trim();
    if (!label) {
      throwApiError(C.ELEVATOR_VALIDATION_FAILED, `第 ${i + 1} 層代號不可為空`);
    }
    if (label.length > DOOR_NAME_MAX_LEN) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `第 ${i + 1} 層代號不可超過 ${DOOR_NAME_MAX_LEN} 字元`,
      );
    }
    const name = String(floor.name ?? "").trim();
    if (name.length > DOOR_NAME_MAX_LEN) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `第 ${i + 1} 層名稱不可超過 ${DOOR_NAME_MAX_LEN} 字元`,
      );
    }
    const rank = normalizePositiveInt(floor.rank);
    if (rank == null) {
      throwApiError(C.ELEVATOR_VALIDATION_FAILED, `第 ${i + 1} 層 rank 無效`);
    }
    if (ranks.has(rank)) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `樓層 rank 重複：${rank}`,
      );
    }
    ranks.add(rank);

    const panelCol = normalizePositiveInt(floor.panelCol) ?? 0;
    const panelRow = normalizePositiveInt(floor.panelRow) ?? 0;
    if (
      panelCol < 0 ||
      panelCol >= normalized.panel.columns ||
      panelRow < 0 ||
      panelRow >= normalized.panel.rows
    ) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `樓層「${label}」面板座標超出範圍`,
      );
    }
    const key = `${panelCol}:${panelRow}`;
    if (panelKeys.has(key)) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `面板座標重複：欄 ${panelCol} 列 ${panelRow}`,
      );
    }
    panelKeys.add(key);

    const openDuration = normalizeOpenDuration(floor.openDuration);
    if (openDuration == null) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `第 ${i + 1} 層繼電器時間須為 ${MIN_OPEN_DURATION}-${MAX_OPEN_DURATION} 秒`,
      );
    }

    const ladderGateway = normalizePositiveInt(floor.ladderGateway);
    const callGateway = normalizePositiveInt(floor.callGateway);
    const diAddress = normalizePositiveInt(floor.diAddress);

    if (
      ladderGateway != null &&
      !isPointInRange(ladderGateway, normalized.ladderDevice)
    ) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `樓層「${label}」梯控 gateway 超出設備起訖`,
      );
    }
    if (
      callGateway != null &&
      !isPointInRange(callGateway, normalized.callDevice)
    ) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `樓層「${label}」呼梯 gateway 超出設備起訖`,
      );
    }
    if (
      diAddress != null &&
      !isPointInRange(diAddress, normalized.floorDetection)
    ) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `樓層「${label}」DI 地址超出設備起訖`,
      );
    }

    return {
      label,
      name: name || undefined,
      rank,
      panelCol,
      panelRow,
      openDuration,
      ladderGateway: ladderGateway ?? null,
      callGateway: callGateway ?? null,
      diAddress: diAddress ?? null,
      bindingOverridden: Boolean(floor.bindingOverridden),
    };
  });

  let withBindings = autoFillBindings(validatedFloors, normalized);

  for (const floor of withBindings) {
    if (
      floor.ladderGateway != null &&
      !isPointInRange(floor.ladderGateway, normalized.ladderDevice)
    ) {
      throwApiError(
        C.ELEVATOR_VALIDATION_FAILED,
        `樓層「${floor.label}」梯控 gateway 無法自動推算，請手動設定`,
      );
    }
  }

  return {
    ...normalized,
    floors: withBindings,
  };
}

function toStoredConfig(validated) {
  const result = {
    panel: validated.panel,
    floors: validated.floors.map((f) => ({
      label: f.label,
      ...(f.name ? { name: f.name } : {}),
      rank: f.rank,
      panel_col: f.panelCol,
      panel_row: f.panelRow,
      open_duration: f.openDuration,
      ...(f.ladderGateway != null ? { ladder_gateway: f.ladderGateway } : {}),
      ...(f.callGateway != null ? { call_gateway: f.callGateway } : {}),
      ...(f.diAddress != null ? { di_address: f.diAddress } : {}),
      ...(f.bindingOverridden ? { binding_overridden: true } : {}),
    })),
    ladder_device: {
      device_id: validated.ladderDevice.deviceId,
      ...(validated.ladderDevice.pointStart != null
        ? { point_start: validated.ladderDevice.pointStart }
        : {}),
      ...(validated.ladderDevice.pointEnd != null
        ? { point_end: validated.ladderDevice.pointEnd }
        : {}),
    },
    access_device_ids:
      validated.accessDeviceIds.length > 0
        ? validated.accessDeviceIds
        : undefined,
  };

  if (validated.callDevice) {
    result.call_device = {
      device_id: validated.callDevice.deviceId,
      ...(validated.callDevice.pointStart != null
        ? { point_start: validated.callDevice.pointStart }
        : {}),
      ...(validated.callDevice.pointEnd != null
        ? { point_end: validated.callDevice.pointEnd }
        : {}),
    };
  }
  if (validated.floorDetection) {
    result.floor_detection = {
      device_id: validated.floorDetection.deviceId,
      ...(validated.floorDetection.pointStart != null
        ? { point_start: validated.floorDetection.pointStart }
        : {}),
      ...(validated.floorDetection.pointEnd != null
        ? { point_end: validated.floorDetection.pointEnd }
        : {}),
    };
  }
  if (validated.logDisplayColumns) {
    result.log_display_columns = validated.logDisplayColumns;
  }
  if (validated.callCommandType) {
    result.call_command_type = validated.callCommandType;
  }
  return result;
}

const getLogicalFloorByIndex = (floors, index) => {
  const i = Number(index);
  if (!Number.isFinite(i) || i < 1 || i > floors.length) return null;
  return { index: i, floor: floors[i - 1] };
};

const resolveFloorDoorName = (floor) => {
  const name = String(floor?.name ?? "").trim();
  const code = String(floor?.label ?? "").trim();
  return name || code;
};

const resolveFloorLabel = (floors, logicalIndex) => {
  const slot = getLogicalFloorByIndex(floors, logicalIndex);
  return slot?.floor?.label ?? null;
};

const resolveLadderGateway = (floors, logicalIndex) => {
  const slot = getLogicalFloorByIndex(floors, logicalIndex);
  return slot?.floor?.ladderGateway ?? null;
};

const logicalIndicesToLadderGateways = (floors, logicalIndices) =>
  (logicalIndices || [])
    .map((idx) => resolveLadderGateway(floors, idx))
    .filter((n) => Number.isFinite(n) && n > 0);

const buildPersonFloorAccessView = (floors, logicalIndices) => ({
  authorized_floor_labels: (logicalIndices || [])
    .map((idx) => {
      const slot = getLogicalFloorByIndex(floors, idx);
      return slot?.floor ? resolveFloorDoorName(slot.floor) : null;
    })
    .filter(Boolean),
  authorized_ladder_gateways: logicalIndicesToLadderGateways(
    floors,
    logicalIndices,
  ),
});

const findFloorByLadderGateway = (floors, gateway) => {
  const gw = Number(gateway);
  if (!Number.isFinite(gw)) return null;
  const index = floors.findIndex((f) => f.ladderGateway === gw);
  if (index < 0) return null;
  return { index: index + 1, floor: floors[index] };
};

const resolveEventFloorLabel = (floors, gateway) => {
  const gw = Number(gateway);
  if (!Number.isFinite(gw)) return null;
  const byLadder = floors.find((f) => f.ladderGateway === gw);
  if (byLadder) return resolveFloorDoorName(byLadder);
  const byCall = floors.find((f) => f.callGateway === gw);
  return byCall ? resolveFloorDoorName(byCall) : null;
};

const findFloorByDiAddress = (floors, address) => {
  const addr = Number(address);
  if (!Number.isFinite(addr)) return null;
  const index = floors.findIndex((f) => f.diAddress === addr);
  if (index < 0) return null;
  return { index: index + 1, floor: floors[index] };
};

const resolveDefaultDisplayFloor = (floors) => {
  if (!floors.length) return null;
  const oneF = floors.find((f) => f.label.trim().toUpperCase() === "1F");
  const target = oneF ?? floors[0];
  const index = floors.indexOf(target) + 1;
  return { index, label: target.label };
};

const formatElevatorLogFloor = (floor, floors) => {
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
        const label = resolveEventFloorLabel(floors, n);
        if (label) return label;
        return part;
      }
      return part;
    })
    .join("、");
};

const mapElevatorLogsFloorDisplay = (logs, floors) =>
  (logs || []).map((log) => ({
    ...log,
    floor: formatElevatorLogFloor(log.floor, floors),
  }));

const sortFloorsByRank = (floors) =>
  [...floors].sort((a, b) => a.rank - b.rank);

const sortFloorsForPanel = (floors) =>
  [...floors].sort((a, b) => {
    if (a.panelRow !== b.panelRow) return a.panelRow - b.panelRow;
    return a.panelCol - b.panelCol;
  });

function collectElevatorFloorSyncTasks(locations) {
  const tasks = [];
  for (const location of locations || []) {
    const sys = (location.systems || []).find(
      (s) => s.systemType === "elevator",
    );
    if (!sys?.config) continue;
    let validated;
    try {
      validated = validateElevatorLocationConfig(sys.config);
    } catch {
      continue;
    }
    if (!validated.ladderDevice?.deviceId || !validated.floors.length) continue;

    const byGateway = new Map();
    for (const floor of validated.floors) {
      if (floor.ladderGateway == null) continue;
      byGateway.set(floor.ladderGateway, {
        name: resolveFloorDoorName(floor),
        openDuration: floor.openDuration,
        gateway: floor.ladderGateway,
      });
    }
    const doorFloors = [...byGateway.values()].sort(
      (a, b) => a.gateway - b.gateway,
    );
    if (!doorFloors.length) continue;

    tasks.push({
      deviceId: validated.ladderDevice.deviceId,
      floors: doorFloors.map(({ name, openDuration }) => ({
        name,
        openDuration,
        gateway: undefined,
      })),
      doorIndexes: doorFloors.map((f) => f.gateway),
    });
  }
  return tasks;
}

function getElevatorConfigFromLocation(location) {
  const sys = (location?.systems || []).find(
    (s) => s.systemType === "elevator",
  );
  const normalized = normalizeElevatorLocationConfig(sys?.config ?? {});
  return {
    ...normalized,
    floors: autoFillBindings(normalized.floors, {
      ladderDevice: normalized.ladderDevice,
      callDevice: normalized.callDevice,
      floorDetection: normalized.floorDetection,
    }),
  };
}

module.exports = {
  MAX_FLOOR_COUNT,
  DEFAULT_OPEN_DURATION,
  PANEL_ROW_COUNT,
  DEFAULT_CALL_COMMAND_TYPE,
  normalizeCallCommandType,
  normalizeElevatorLocationConfig,
  validateElevatorLocationConfig,
  toStoredConfig,
  getLogicalFloorByIndex,
  resolveFloorLabel,
  resolveFloorDoorName,
  resolveLadderGateway,
  logicalIndicesToLadderGateways,
  buildPersonFloorAccessView,
  findFloorByLadderGateway,
  findFloorByDiAddress,
  resolveDefaultDisplayFloor,
  formatElevatorLogFloor,
  mapElevatorLogsFloorDisplay,
  sortFloorsByRank,
  sortFloorsForPanel,
  collectElevatorFloorSyncTasks,
  getElevatorConfigFromLocation,
  autoFillBindings,
};
