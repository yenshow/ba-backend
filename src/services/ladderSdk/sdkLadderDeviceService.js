/**
 * 梯控 SDK 設備連線解析
 * 支援 controller (protocol=hcnet_sdk) 或 access_control（含 sdk_port）
 */
const deviceService = require("../devices/deviceService");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");
const { resolveHcnetSdkPort } = require("../../utils/deviceHelpers");

const resolveSdkCredentials = (device) => {
  const cfg = device.config || {};

  if (device.type_code === "controller" && cfg.protocol === "hcnet_sdk") {
    if (!cfg.host || !cfg.username || !cfg.password) {
      throw createApiError(
        C.LADDER_SDK_CONFIG_INCOMPLETE,
        "梯控設備連線設定不完整（需要 host / username / password）",
      );
    }

    return {
      host: cfg.host,
      port: resolveHcnetSdkPort(cfg, null),
      username: cfg.username,
      password: cfg.password,
    };
  }

  if (device.type_code === "access_control") {
    if (!cfg.host || !cfg.username || !cfg.password) {
      throw createApiError(
        C.LADDER_SDK_CONFIG_INCOMPLETE,
        "門禁設備連線設定不完整（需要 host / username / password）",
      );
    }

    const sdkPort = Number(cfg.sdk_port ?? cfg.sdkPort);
    return {
      host: cfg.host,
      port: Number.isFinite(sdkPort) && sdkPort > 0 ? sdkPort : 8000,
      username: cfg.username,
      password: cfg.password,
    };
  }

  if (device.type_code === "video_intercom") {
    if (!cfg.host || !cfg.username || !cfg.password) {
      throw createApiError(
        C.LADDER_SDK_CONFIG_INCOMPLETE,
        "對講設備連線設定不完整（需要 host / username / password）",
      );
    }
    const port = Number(cfg.port ?? cfg.sdk_port ?? cfg.sdkPort);
    return {
      host: cfg.host,
      port: Number.isFinite(port) && port > 0 ? port : 8000,
      username: cfg.username,
      password: cfg.password,
    };
  }

  throw createApiError(
    C.LADDER_SDK_NOT_DEVICE,
    "該設備不支援 HCNetSDK（需 controller+hcnet_sdk、access_control 或 video_intercom）",
  );
};

const getLadderDevice = async (deviceId) => {
  const { device } = await deviceService.getDeviceById(deviceId);
  const credentials = resolveSdkCredentials(device);
  return { device, credentials };
};

const toBridgeDevice = (credentials) => ({
  host: credentials.host,
  port: credentials.port,
  username: credentials.username,
  password: credentials.password,
});

module.exports = {
  getLadderDevice,
  resolveSdkCredentials,
  toBridgeDevice,
};
