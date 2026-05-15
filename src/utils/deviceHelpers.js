// 設備相關共用工具函數

const { deviceConfigInvalid } = require("./deviceErrors");

/**
 * 解析 JSON 配置（處理字串或物件格式）
 */
const parseConfig = (config) => {
  if (!config) return null;
  return typeof config === "string" ? JSON.parse(config) : config;
};

/**
 * 序列化配置為 JSON 字串
 */
const stringifyConfig = (config) => {
  if (!config) return null;
  return typeof config === "string" ? config : JSON.stringify(config);
};

/**
 * 驗證設備配置
 */
const validateDeviceConfig = (config, typeCode) => {
  if (!config || typeof config !== "object") {
    deviceConfigInvalid("config 必須是有效的 JSON 物件");
  }

  if (config.type !== typeCode) {
    deviceConfigInvalid(`config.type 必須為 "${typeCode}"`);
  }

  switch (typeCode) {
    case "controller":
      if (!config.host || typeof config.host !== "string") {
        deviceConfigInvalid("controller 類型需要 host (string)");
      }
      if (config.port !== undefined && typeof config.port !== "number") {
        deviceConfigInvalid("controller 類型的 port 必須是數字");
      }
      if (config.unitId !== undefined && typeof config.unitId !== "number") {
        deviceConfigInvalid("controller 類型的 unitId 必須是數字");
      }
      break;

    case "camera": {
      const rtspUrl =
        config.rtsp_url && typeof config.rtsp_url === "string"
          ? config.rtsp_url.trim()
          : "";
      if (!rtspUrl || !rtspUrl.toLowerCase().startsWith("rtsp://")) {
        deviceConfigInvalid(
          "camera 類型需要 rtsp_url (string)，且需以 rtsp:// 開頭，例如 rtsp://admin:xxx@192.168.2.102:554/Streaming/Channels/102",
        );
      }
      break;
    }

    case "sensor":
      if (
        !config.protocol ||
        !["modbus", "http", "mqtt"].includes(config.protocol)
      ) {
        deviceConfigInvalid("sensor 類型需要 protocol (modbus, http, 或 mqtt)");
      }
      if (config.protocol === "modbus") {
        if (!config.host || typeof config.host !== "string") {
          deviceConfigInvalid("sensor (modbus) 需要 host (string)");
        }
        if (
          config.port !== undefined &&
          config.port !== null &&
          (typeof config.port !== "number" || config.port < 1 || config.port > 65535)
        ) {
          deviceConfigInvalid("sensor (modbus) 的 port 須為 1-65535 的數字");
        }
        if (
          config.unitId !== undefined &&
          config.unitId !== null &&
          (typeof config.unitId !== "number" ||
            config.unitId < 1 ||
            config.unitId > 255)
        ) {
          deviceConfigInvalid(
            "sensor (modbus) 類型的 unitId 必須是 1-255 的數字",
          );
        }
      } else if (config.protocol === "http") {
        if (!config.api_endpoint || typeof config.api_endpoint !== "string") {
          deviceConfigInvalid("sensor (http) 需要 api_endpoint (string)");
        }
      } else if (config.protocol === "mqtt") {
        if (
          !config.connection_string ||
          typeof config.connection_string !== "string"
        ) {
          deviceConfigInvalid("sensor (mqtt) 需要 connection_string (string)");
        }
      }
      break;

    case "access_control":
      if (!config.host || typeof config.host !== "string") {
        deviceConfigInvalid("access_control 類型需要 host (string)");
      }
      if (!config.username || typeof config.username !== "string") {
        deviceConfigInvalid("access_control 類型需要 username (string)");
      }
      if (!config.password || typeof config.password !== "string") {
        deviceConfigInvalid("access_control 類型需要 password (string)");
      }
      if (config.port !== undefined && config.port !== null) {
        const p = Number(config.port);
        if (Number.isNaN(p) || p < 1 || p > 65535) {
          deviceConfigInvalid(
            "access_control 類型的 port 必須為 1–65535 的數字",
          );
        }
      }
      break;

    default:
      deviceConfigInvalid(`未知的設備類型: ${typeCode}`);
  }
};

/**
 * 驗證 logging 配置
 */
const validateLoggingConfig = (config) => {
  if (!config || typeof config !== "object") {
    return { valid: false, error: "logging 配置必須是物件" };
  }

  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    return { valid: false, error: "logging.enabled 必須是布林值" };
  }

  if (config.interval !== undefined) {
    if (typeof config.interval !== "number" || config.interval < 1) {
      return { valid: false, error: "logging.interval 必須是大於 0 的數字" };
    }
  }

  if (config.values !== undefined) {
    if (!Array.isArray(config.values)) {
      return { valid: false, error: "logging.values 必須是陣列" };
    }

    for (const value of config.values) {
      if (!value.name || typeof value.name !== "string") {
        return { valid: false, error: "logging.values[].name 必須是字串" };
      }
      if (
        !["holding", "input", "coil", "discrete"].includes(value.register_type)
      ) {
        return {
          valid: false,
          error: `無效的暫存器類型: ${value.register_type}`,
        };
      }
      if (typeof value.address !== "number" || value.address < 0) {
        return {
          valid: false,
          error: "logging.values[].address 必須是非負整數",
        };
      }
      if (
        value.length !== undefined &&
        (typeof value.length !== "number" || value.length < 1)
      ) {
        return {
          valid: false,
          error: "logging.values[].length 必須是大於 0 的數字",
        };
      }
      if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
        return { valid: false, error: "logging.values[].enabled 必須是布林值" };
      }
      if (value.conversion !== undefined) {
        if (typeof value.conversion !== "object") {
          return {
            valid: false,
            error: "logging.values[].conversion 必須是物件",
          };
        }
        if (
          value.conversion.formula !== undefined &&
          typeof value.conversion.formula !== "string"
        ) {
          return {
            valid: false,
            error: "logging.values[].conversion.formula 必須是字串",
          };
        }
        if (
          value.conversion.unit !== undefined &&
          typeof value.conversion.unit !== "string"
        ) {
          return {
            valid: false,
            error: "logging.values[].conversion.unit 必須是字串",
          };
        }
        if (
          value.conversion.scale !== undefined &&
          typeof value.conversion.scale !== "number"
        ) {
          return {
            valid: false,
            error: "logging.values[].conversion.scale 必須是數字",
          };
        }
        if (
          value.conversion.offset !== undefined &&
          typeof value.conversion.offset !== "number"
        ) {
          return {
            valid: false,
            error: "logging.values[].conversion.offset 必須是數字",
          };
        }
      }
    }
  }

  return { valid: true };
};

module.exports = {
  parseConfig,
  stringifyConfig,
  validateDeviceConfig,
  validateLoggingConfig,
};
