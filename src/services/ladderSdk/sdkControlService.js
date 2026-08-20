/**
 * 梯控呼梯／開關門（NET_DVR_ControlGateway）
 */
const { invokeBridge } = require("./sdkBridgeClient");
const { getLadderDevice, toBridgeDevice } = require("./sdkLadderDeviceService");
const { recordPlatformCallElevator } = require("./sdkEventPersistence");
const { isElevatorBoundDeviceId } = require("../location/controllerBindingUtils");
const elevatorService = require("../elevator/elevatorService");
const elevatorRuntimeService = require("../elevator/elevatorRuntimeService");
const {
  DEFAULT_OPEN_DURATION,
  findFloorByLadderGateway,
} = require("../elevator/elevatorFloorModel");
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("ladderSdkControl");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");

/** dwStaic 對照（HCNetSDK NET_DVR_ControlGateway） */
const GATEWAY_COMMANDS = {
  close: 0,
  open: 1,
  manual: 1,
  normally_open: 2,
  normally_closed: 3,
  recovery: 4,
  visitor_call: 5,
};

const CALL_COMMAND = GATEWAY_COMMANDS.visitor_call;
const OPEN_COMMAND = GATEWAY_COMMANDS.open;
const CANCEL_CLOSE_COMMANDS = new Set([
  GATEWAY_COMMANDS.close,
  GATEWAY_COMMANDS.normally_open,
  GATEWAY_COMMANDS.normally_closed,
]);

/** @type {Map<string, NodeJS.Timeout>} */
const pendingManualCloses = new Map();

const timerKey = (deviceId, gatewayIndex) =>
  `${Number(deviceId)}:${Number(gatewayIndex)}`;

const invalidGatewayError = () =>
  createApiError(
    C.LADDER_SDK_INVALID_GATEWAY,
    "gatewayIndex 須為 -1（全部）或 >= 1（樓層）",
  );

const cancelScheduledClose = (deviceId, gatewayIndex) => {
  const key = timerKey(deviceId, gatewayIndex);
  const timer = pendingManualCloses.get(key);
  if (!timer) return;
  clearTimeout(timer);
  pendingManualCloses.delete(key);
};

const scheduleManualClose = (deviceId, gatewayIndex, delaySec) => {
  const seconds = Number(delaySec);
  const delayMs =
    (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_OPEN_DURATION) *
    1000;
  cancelScheduledClose(deviceId, gatewayIndex);
  const key = timerKey(deviceId, gatewayIndex);
  const timer = setTimeout(() => {
    pendingManualCloses.delete(key);
    void controlGateway(deviceId, {
      gatewayIndex,
      command: GATEWAY_COMMANDS.close,
    }).catch((error) => {
      logger.warn("手動開門逾時關閉失敗", {
        deviceId,
        gatewayIndex,
        error: error?.message || String(error),
      });
    });
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  pendingManualCloses.set(key, timer);
};

const resolveCommand = (raw) => {
  if (raw == null) return GATEWAY_COMMANDS.open;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;

  const key = String(raw).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(GATEWAY_COMMANDS, key)) {
    return GATEWAY_COMMANDS[key];
  }

  throw createApiError(
    C.LADDER_SDK_INVALID_COMMAND,
    "command 須為 open / manual / normally_open / normally_closed / visitor_call",
  );
};

const normalizeGatewayIndexes = (options = {}) => {
  const raw = Array.isArray(options.gatewayIndexes)
    ? options.gatewayIndexes
    : [options.gatewayIndex ?? 1];
  const indexes = [];
  for (const value of raw) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < -1 || n === 0) throw invalidGatewayError();
    if (!indexes.includes(n)) indexes.push(n);
  }
  if (indexes.length === 0) throw invalidGatewayError();
  if (indexes.includes(-1) && indexes.length > 1) {
    throw createApiError(
      C.LADDER_SDK_INVALID_GATEWAY,
      "gatewayIndex -1 不可與其他樓層一併送出",
    );
  }
  return indexes;
};

const controlGateway = async (deviceId, options = {}) => {
  const gatewayIndex =
    options.gatewayIndex != null ? Number(options.gatewayIndex) : 1;
  const command = resolveCommand(options.command);
  if (gatewayIndex < -1 || gatewayIndex === 0) throw invalidGatewayError();

  const { credentials } = await getLadderDevice(deviceId);
  return invokeBridge({
    action: "control.gateway",
    device: toBridgeDevice(credentials),
    payload: { gatewayIndex, command },
  });
};

async function resolveCallElevatorContext(deviceId, options) {
  const locationId = Number(options.locationId);
  const targetLogicalIndex = Number(options.targetLogicalIndex);
  if (
    !Number.isFinite(locationId) ||
    locationId <= 0 ||
    !Number.isFinite(targetLogicalIndex) ||
    targetLogicalIndex <= 0
  ) {
    return null;
  }

  const { location } = await elevatorService.getElevatorLocationById(locationId);
  const config = elevatorService.getElevatorConfig(location);
  if (Number(config.callDevice?.deviceId) !== Number(deviceId)) {
    throw createApiError(C.ELEVATOR_VALIDATION_FAILED, "呼梯設備與地點不符", {
      statusCode: 400,
    });
  }
  return { locationId, targetLogicalIndex, config };
}

async function resolveDoorControlConfig(deviceId, locationId) {
  let resolvedId = Number(locationId);
  if (!Number.isFinite(resolvedId) || resolvedId <= 0) {
    const id = Number(deviceId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const rows = await db.query(
      `SELECT location_id
       FROM location_systems
       WHERE system_type = 'elevator'
         AND (system_config->'ladder_device'->>'device_id')::int = ?
       LIMIT 1`,
      [id],
    );
    resolvedId = Number(rows?.[0]?.location_id);
  }
  if (!Number.isFinite(resolvedId) || resolvedId <= 0) return null;

  try {
    const { location } =
      await elevatorService.getElevatorLocationById(resolvedId);
    const config = elevatorService.getElevatorConfig(location);
    const ladderId = Number(config.ladderDevice?.deviceId);
    if (ladderId && ladderId !== Number(deviceId)) return null;
    return config;
  } catch {
    return null;
  }
}

const resolveOpenDuration = (config, gatewayIndex) => {
  const duration = Number(
    findFloorByLadderGateway(config?.floors ?? [], gatewayIndex)?.floor
      ?.openDuration,
  );
  return Number.isFinite(duration) && duration > 0
    ? duration
    : DEFAULT_OPEN_DURATION;
};

/**
 * 電梯監控頁控制：設備管理員可控制任意梯控；僅具 elevator.device.control 者限已綁定電梯地點的設備。
 * 呼梯（visitor_call）且帶 locationId／targetLogicalIndex 時更新運行態並回傳 live。
 * 門控可帶 gatewayIndexes[]；手動 open 成功後依該層 openDuration 排程 close。
 */
const controlGatewayForElevatorRequest = async (
  deviceId,
  options = {},
  { allowAnyLadderDevice = false } = {},
) => {
  if (!allowAnyLadderDevice) {
    const bound = await isElevatorBoundDeviceId(deviceId);
    if (!bound) {
      throw createApiError(C.PERMISSION_DENIED, "設備不屬於電梯系統", {
        statusCode: 403,
      });
    }
  }

  const command = resolveCommand(options.command);
  const gatewayIndexes = normalizeGatewayIndexes(options);
  const isCall = command === CALL_COMMAND;

  if (isCall && gatewayIndexes.length !== 1) {
    throw createApiError(C.LADDER_SDK_INVALID_GATEWAY, "呼梯僅能指定單一樓層");
  }

  if (isCall) {
    const gatewayIndex = gatewayIndexes[0];
    const callContext = await resolveCallElevatorContext(deviceId, options);
    const bridgeResult = await controlGateway(deviceId, {
      gatewayIndex,
      command,
    });
    if (!options.skipPlatformCallAudit) {
      void recordPlatformCallElevator({
        deviceId: Number(deviceId),
        gatewayIndex,
      }).catch(() => {});
    }
    if (!callContext) return bridgeResult;
    return {
      ...bridgeResult,
      live: elevatorRuntimeService.notifyCallElevator(
        callContext.locationId,
        callContext.targetLogicalIndex,
        callContext.config,
      ),
    };
  }

  const doorConfig =
    command === OPEN_COMMAND
      ? await resolveDoorControlConfig(deviceId, options.locationId)
      : null;
  const { credentials } = await getLadderDevice(deviceId);
  const device = toBridgeDevice(credentials);
  const results = [];
  const scheduledClose = [];

  for (const gatewayIndex of gatewayIndexes) {
    try {
      await invokeBridge({
        action: "control.gateway",
        device,
        payload: { gatewayIndex, command },
      });
      if (command === OPEN_COMMAND && gatewayIndex >= 1 && doorConfig) {
        const delaySec = resolveOpenDuration(doorConfig, gatewayIndex);
        scheduleManualClose(deviceId, gatewayIndex, delaySec);
        scheduledClose.push({ gatewayIndex, delaySec });
      } else if (CANCEL_CLOSE_COMMANDS.has(command)) {
        cancelScheduledClose(deviceId, gatewayIndex);
      }
      results.push({ gatewayIndex, ok: true });
    } catch (error) {
      results.push({
        gatewayIndex,
        ok: false,
        error: error?.message || String(error),
      });
    }
  }

  if (results.length > 0 && results.every((row) => !row.ok)) {
    throw createApiError(
      C.LADDER_SDK_CONTROL_FAILED,
      results.length === 1 ? results[0].error || "門控操作失敗" : "門控操作失敗",
      { details: { results } },
    );
  }

  return { results, scheduledClose };
};

module.exports = {
  controlGateway,
  controlGatewayForElevatorRequest,
  resolveCommand,
};
