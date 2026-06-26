/**
 * 梯控呼梯／開關門（NET_DVR_ControlGateway）
 */
const { invokeBridge } = require("./sdkBridgeClient");
const { getLadderDevice, toBridgeDevice } = require("./sdkLadderDeviceService");
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

module.exports = {
  controlGateway,
  resolveCommand,
  isCallElevatorCommand,
};
