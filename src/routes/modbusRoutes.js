const express = require("express");
const modbusClient = require("../services/devices/modbusClient");
const modbusBatchService = require("../services/devices/modbusBatchService");
const systemAlert = require("../services/alerts/systemAlertHelper");
const { authenticate } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const {
  validateRequired,
} = require("../middleware/validation");
const logger = require("../utils/logger");

const router = express.Router();

const modbusLogger = logger.createLogger("ModbusRoutes");

const parseAddressParams = (req) => {
  const address = Number(req.query.address ?? 0);
  // length 參數可選，預設為 1（讀取單個寄存器）
  const length = req.query.length !== undefined ? Number(req.query.length) : 1;

  if (!Number.isInteger(address) || address < 0) {
    throw new Error("address must be a non-negative integer");
  }

  if (!Number.isInteger(length) || length <= 0 || length > 125) {
    throw new Error("length must be an integer between 1 and 125");
  }

  return { address, length };
};

// 解析設備連接參數（必填）
const parseDeviceParams = (req) => {
  // host 是必填
  if (
    !req.query.host ||
    typeof req.query.host !== "string" ||
    req.query.host.trim() === ""
  ) {
    throw new Error("host is required (device IP address)");
  }
  const host = req.query.host.trim();

  // port 是必填
  if (req.query.port === undefined) {
    throw new Error("port is required");
  }
  const port = Number(req.query.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }

  // unitId 是必填
  if (req.query.unitId === undefined) {
    throw new Error("unitId is required");
  }
  const unitId = Number(req.query.unitId);
  if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) {
    throw new Error("unitId must be an integer between 0 and 255");
  }

  return { host, port, unitId };
};

// 以下路由皆需登入
router.use(authenticate);

const routeFactory = (reader) =>
  asyncHandler(async (req, res) => {
    const { address, length } = parseAddressParams(req);
    const deviceConfig = parseDeviceParams(req);
    const data = await reader(address, length, deviceConfig);

    // 成功讀取資料時，清除設備錯誤狀態（設備已恢復連線）
    systemAlert
      .getDeviceIdFromConfig(deviceConfig)
      .then((deviceId) => {
        if (deviceId) {
          return systemAlert.clearError("device", deviceId);
        }
      })
      .catch((error) => {
        // 靜默處理，不影響正常響應
        modbusLogger.warn("清除設備錯誤狀態失敗", { error: error.message });
      });

    res.sendSuccess({ address, length, data, device: deviceConfig });
  });

router.get(
  "/health",
  noCache,
  asyncHandler(async (req, res) => {
    const deviceConfig = parseDeviceParams(req);
    const status = modbusClient.getStatus(deviceConfig);
    res.sendSuccess(status);
  }),
);

router.get(
  "/holding-registers",
  routeFactory(modbusClient.readHoldingRegisters.bind(modbusClient)),
);
router.get(
  "/input-registers",
  routeFactory(modbusClient.readInputRegisters.bind(modbusClient)),
);
router.get("/coils", routeFactory(modbusClient.readCoils.bind(modbusClient)));
router.get(
  "/discrete-inputs",
  routeFactory(modbusClient.readDiscreteInputs.bind(modbusClient)),
);

// POST /batch-read - 批次讀取（自動合併連續 address 範圍、內建快取/去重）
router.post(
  "/batch-read",
  noCache,
  asyncHandler(async (req, res) => {
    const requests = req.body?.requests;
    if (!Array.isArray(requests)) {
      return res.sendError("requests must be an array", 400);
    }
    if (requests.length === 0) {
      return res.sendSuccess({ results: [] });
    }
    if (requests.length > 2000) {
      return res.sendError("requests too large (max 2000)", 400);
    }

    const results = await modbusBatchService.batchRead(requests);

    // 成功讀取資料時，清除設備錯誤狀態（device 連線恢復）
    // 這裡只對 batch 中「成功」且能反推 deviceId 的項目做清除；失敗保持不動
    Promise.allSettled(
      results
        .filter((r) => r && r.ok && r.device)
        .map((r) =>
          systemAlert
            .getDeviceIdFromConfig(r.device)
            .then((deviceId) => {
              if (deviceId) return systemAlert.clearError("device", deviceId);
            })
            .catch(() => null),
        ),
    ).catch(() => null);

    res.sendSuccess({ results });
  }),
);

// PUT /coils - 寫入單個或多個 DO
router.put(
  "/coils",
  noCache,
  validateRequired("address"),
  asyncHandler(async (req, res) => {
    const { address, value, values } = req.body;
    const deviceConfig = parseDeviceParams(req);

    if (
      typeof address !== "number" ||
      address < 0 ||
      !Number.isInteger(address)
    ) {
      return res.sendError("address must be a non-negative integer", 400);
    }

    // 單個寫入
    if (typeof value === "boolean") {
      const success = await modbusClient.writeCoil(
        address,
        value,
        deviceConfig,
      );
      if (success) {
        modbusBatchService.invalidateDeviceCache(deviceConfig, "coil");
      }
      return res.sendSuccess({ address, value, success, device: deviceConfig });
    }

    // 多個寫入
    if (Array.isArray(values)) {
      if (values.length === 0 || values.length > 125) {
        return res.sendError(
          "values array length must be between 1 and 125",
          400,
        );
      }
      if (!values.every((v) => typeof v === "boolean")) {
        return res.sendError("all values must be boolean", 400);
      }
      const success = await modbusClient.writeCoils(
        address,
        values,
        deviceConfig,
      );
      if (success) {
        modbusBatchService.invalidateDeviceCache(deviceConfig, "coil");
      }
      return res.sendSuccess({
        address,
        values,
        success,
        device: deviceConfig,
      });
    }

    return res.sendError(
      "must provide either value (boolean) or values (boolean[])",
      400,
    );
  }),
);

module.exports = router;
