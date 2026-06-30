/**
 * 梯控呼梯／開關門（NET_DVR_ControlGateway）
 */
const { invokeBridge } = require("./sdkBridgeClient");
const { getLadderDevice, toBridgeDevice } = require("./sdkLadderDeviceService");
const { recordPlatformCallElevator } = require("./sdkEventPersistence");
const { isElevatorBoundDeviceId } = require("../location/controllerBindingUtils");
const elevatorService = require("../elevator/elevatorService");
const elevatorRuntimeService = require("../elevator/elevatorRuntimeService");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrorMeta");

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

const CALL_ELEVATOR_COMMANDS = new Set([GATEWAY_COMMANDS.visitor_call]);

const resolveCommand = (raw) => {
  if (raw == null) {
    return GATEWAY_COMMANDS.open;
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }

  const key = String(raw).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(GATEWAY_COMMANDS, key)) {
    return GATEWAY_COMMANDS[key];
  }

  throw createApiError(
    C.LADDER_SDK_INVALID_COMMAND,
    "command 須為 open / manual / normally_open / normally_closed / visitor_call",
  );
};

const isCallElevatorCommand = (raw) => {
  const resolved = resolveCommand(raw);
  return CALL_ELEVATOR_COMMANDS.has(resolved);
};

const controlGateway = async (deviceId, options = {}) => {
  const gatewayIndex =
    options.gatewayIndex != null ? Number(options.gatewayIndex) : 1;
  const command = resolveCommand(options.command);

  if (gatewayIndex < -1 || gatewayIndex === 0) {
    throw createApiError(
      C.LADDER_SDK_INVALID_GATEWAY,
      "gatewayIndex 須為 -1（全部）或 >= 1（樓層）",
    );
  }

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
  const callDeviceId = Number(config.callDevice?.deviceId);
  if (callDeviceId !== Number(deviceId)) {
    throw createApiError(C.ELEVATOR_VALIDATION_FAILED, "呼梯設備與地點不符", {
      statusCode: 400,
    });
  }

  return { locationId, targetLogicalIndex, config };
}

/**
 * 電梯監控頁控制：設備管理員可控制任意梯控；僅具 elevator.device.control 者限已綁定電梯地點的設備。
 * 呼梯（visitor_call）且帶 locationId／targetLogicalIndex 時更新運行態並回傳 live。
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

  const isCall = isCallElevatorCommand(options.command);
  const callContext = isCall
    ? await resolveCallElevatorContext(deviceId, options)
    : null;

  const bridgeResult = await controlGateway(deviceId, options);

  if (isCall) {
    const gatewayIndex =
      options.gatewayIndex != null ? Number(options.gatewayIndex) : 1;
    void recordPlatformCallElevator({
      deviceId: Number(deviceId),
      gatewayIndex,
    }).catch(() => {});
  }

  if (!callContext) {
    return bridgeResult;
  }

  const live = elevatorRuntimeService.notifyCallElevator(
    callContext.locationId,
    callContext.targetLogicalIndex,
    callContext.config,
  );
  return { ...bridgeResult, live };
};

module.exports = {
  controlGateway,
  controlGatewayForElevatorRequest,
  resolveCommand,
  isCallElevatorCommand,
};
