const db = require("../../database/db");
const { parseConfig, stringifyConfig } = require("../../utils/deviceHelpers");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const { throwApiError, causeDetails } = require("../../utils/apiErrors");
const {
  rethrowIfApiError,
  failDeviceModelList,
  failDeviceModelGet,
  failDeviceModelCreate,
  failDeviceModelUpdate,
  failDeviceModelDelete,
} = require("../../utils/deviceErrors");
const {
  normalizeDeviceTypeCode,
  getDeviceTypeName,
} = require("../../constants/deviceTypes");

const deviceModelLogger = logger.createLogger("deviceModelService");

function parseOptionalInt(val) {
  if (val === undefined || val === null || val === "") return null;
  const n = Number(val);
  return Number.isInteger(n) ? n : null;
}

async function getAllDeviceModels(filters = {}) {
  try {
    const { type_code, category_code } = filters;

    let query = `
			SELECT 
				dm.*
			FROM device_models dm
			WHERE 1=1
		`;
    const params = [];

    if (type_code) {
      query += " AND dm.type_code = ?";
      params.push(type_code);
    }
    if (category_code) {
      query += " AND dm.category_code = ?";
      params.push(category_code);
    }

    query += " ORDER BY dm.type_code, dm.category_code NULLS LAST, dm.id";

    const models = await db.query(query, params);

    const modelsWithConfig = models.map((model) => ({
      ...model,
      type_name: getDeviceTypeName(model.type_code),
      config: parseConfig(model.config),
    }));

    return { device_models: modelsWithConfig };
  } catch (error) {
    rethrowIfApiError(error);
    deviceModelLogger.error("取得設備型號失敗", {
      error: error?.message || String(error),
      module: "deviceModelService",
    });
    failDeviceModelList("取得設備型號失敗", causeDetails(error));
  }
}

async function getDeviceModelById(id) {
  try {
    const models = await db.query(
      `
			SELECT 
				dm.*
			FROM device_models dm
			WHERE dm.id = ?
		`,
      [id],
    );

    if (models.length === 0) {
      throwApiError(C.DEVICE_MODEL_NOT_FOUND, "設備型號不存在");
    }

    const model = models[0];
    model.type_name = getDeviceTypeName(model.type_code);
    model.config = parseConfig(model.config);

    return { device_model: model };
  } catch (error) {
    rethrowIfApiError(error);
    deviceModelLogger.error("取得設備型號失敗", {
      id,
      error: error?.message || String(error),
      module: "deviceModelService",
    });
    failDeviceModelGet("取得設備型號失敗", causeDetails(error));
  }
}

function validateSensorParametersConfig(config) {
  if (!config || typeof config !== "object") {
    return;
  }

  if (config.sensorParameters) {
    if (!Array.isArray(config.sensorParameters)) {
      throwApiError(
        C.DEVICE_MODEL_SENSOR_PARAMETERS_INVALID,
        "sensorParameters 必須為陣列",
      );
    }

    const validParameterTypes = [
      "pm25",
      "pm10",
      "tvoc",
      "hcho",
      "humidity",
      "temperature",
      "co2",
      "noise",
      "wind",
    ];

    for (const param of config.sensorParameters) {
      if (!param.type) {
        throwApiError(
          C.DEVICE_MODEL_SENSOR_PARAMETERS_INVALID,
          "參數定義必須包含 type 欄位",
        );
      }
      if (!validParameterTypes.includes(param.type)) {
        throwApiError(
          C.DEVICE_MODEL_SENSOR_PARAMETERS_INVALID,
          `無效的參數類型: ${param.type}。有效類型: ${validParameterTypes.join(", ")}`,
        );
      }
      if (!param.modbusConfig) {
        throwApiError(
          C.DEVICE_MODEL_SENSOR_PARAMETERS_INVALID,
          `參數 ${param.type} 必須包含 modbusConfig`,
        );
      }
      if (
        typeof param.modbusConfig.address !== "number" ||
        param.modbusConfig.address < 0
      ) {
        throwApiError(
          C.DEVICE_MODEL_SENSOR_PARAMETERS_INVALID,
          `參數 ${param.type} 的 modbusConfig.address 必須為非負整數`,
        );
      }
    }

    const validRegisterTypes = ["coils", "discrete", "holding", "input"];
    if (
      config.registerType != null &&
      !validRegisterTypes.includes(config.registerType)
    ) {
      throwApiError(
        C.DEVICE_MODEL_REGISTER_TYPE_INVALID,
        `config.registerType 須為 ${validRegisterTypes.join(", ")} 之一`,
      );
    }
  }
}

async function createDeviceModel(data, userId) {
  try {
    const { name, type_code, category_code, port, unit_id, description, config } =
      data;

    if (!name || name.trim().length === 0) {
      throwApiError(C.DEVICE_MODEL_NAME_REQUIRED, "設備型號名稱不能為空");
    }

    const inputTypeCode = normalizeDeviceTypeCode(type_code);
    if (!inputTypeCode) {
      throwApiError(C.DEVICE_TYPE_REQUIRED, "設備類型不能為空");
    }

    const finalPort = parseOptionalInt(port);
    if (finalPort !== null && (finalPort < 1 || finalPort > 65535)) {
      throwApiError(C.DEVICE_MODEL_PORT_INVALID, "端口必須是 1-65535 之間的整數");
    }
    const finalUnitId = parseOptionalInt(unit_id);
    if (finalUnitId !== null && (finalUnitId < 1 || finalUnitId > 255)) {
      throwApiError(
        C.DEVICE_MODEL_UNIT_ID_INVALID,
        "Unit ID 必須是 1-255 之間的整數",
      );
    }

    const resolvedTypeCode = inputTypeCode;

    const finalCategoryCode =
      category_code != null && String(category_code).trim()
        ? String(category_code).trim()
        : null;
    if (finalCategoryCode && finalCategoryCode.length > 50) {
      throwApiError(C.DEVICE_MODEL_CATEGORY_CODE_INVALID, "category_code 長度過長");
    }

    if (config && resolvedTypeCode === "sensor") {
      validateSensorParametersConfig(config);
    }

    if (config && config.logging) {
      const { validateLoggingConfig } = require("../../utils/deviceHelpers");
      const loggingValidation = validateLoggingConfig(config.logging);
      if (!loggingValidation.valid) {
        throwApiError(
          C.DEVICE_LOGGING_CONFIG_INVALID,
          `logging 配置驗證失敗: ${loggingValidation.error}`,
        );
      }
    }

    const result = await db.query(
      "INSERT INTO device_models (name, type_code, category_code, port, unit_id, description, config) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      [
        name.trim(),
        resolvedTypeCode,
        finalCategoryCode,
        finalPort,
        finalUnitId,
        description || null,
        stringifyConfig(config),
      ],
    );

    const models = await db.query(
      `
			SELECT 
				dm.*
			FROM device_models dm
			WHERE dm.id = ?
		`,
      [result[0].id],
    );

    const model = models[0];
    model.type_name = getDeviceTypeName(model.type_code);
    model.config = parseConfig(model.config);

    return {
      message: "設備型號建立成功",
      device_model: model,
    };
  } catch (error) {
    rethrowIfApiError(error);
    deviceModelLogger.error("建立設備型號失敗", {
      error: error?.message || String(error),
      module: "deviceModelService",
    });
    failDeviceModelCreate("建立設備型號失敗", causeDetails(error));
  }
}

async function updateDeviceModel(id, data, userId) {
  try {
    const { name, type_code, category_code, port, unit_id, description, config } =
      data;

    const existing = await db.query("SELECT * FROM device_models WHERE id = ?", [
      id,
    ]);

    if (existing.length === 0) {
      throwApiError(C.DEVICE_MODEL_NOT_FOUND, "設備型號不存在");
    }

    if (port !== undefined) {
      const p = parseOptionalInt(port);
      if (p !== null && (p < 1 || p > 65535)) {
        throwApiError(
          C.DEVICE_MODEL_PORT_INVALID,
          "端口必須是 1-65535 之間的整數",
        );
      }
    }
    if (unit_id !== undefined) {
      const u = parseOptionalInt(unit_id);
      if (u !== null && (u < 1 || u > 255)) {
        throwApiError(
          C.DEVICE_MODEL_UNIT_ID_INVALID,
          "Unit ID 必須是 1-255 之間的整數",
        );
      }
    }

    const existingModel = existing[0];
    const currentTypeCode = String(existingModel.type_code || "");

    const inputTypeCode =
      type_code !== undefined ? normalizeDeviceTypeCode(type_code) : null;
    if (type_code !== undefined && !inputTypeCode) {
      throwApiError(C.DEVICE_TYPE_INVALID, "設備類型代碼不正確");
    }
    const wantsChangeType = inputTypeCode && inputTypeCode !== currentTypeCode;
    if (wantsChangeType) {
      const devices = await db.query(
        "SELECT id FROM devices WHERE model_id = ? LIMIT 1",
        [id],
      );
      if (devices.length > 0) {
        throwApiError(
          C.DEVICE_MODEL_TYPE_CHANGE_FORBIDDEN,
          "無法更改類型：仍有設備使用此型號",
        );
      }
    }

    if (config !== undefined) {
      const targetTypeCode = inputTypeCode || currentTypeCode;
      if (targetTypeCode === "sensor") {
        validateSensorParametersConfig(config);
      }

      if (config.logging) {
        const { validateLoggingConfig } = require("../../utils/deviceHelpers");
        const loggingValidation = validateLoggingConfig(config.logging);
        if (!loggingValidation.valid) {
          throwApiError(
            C.DEVICE_LOGGING_CONFIG_INVALID,
            `logging 配置驗證失敗: ${loggingValidation.error}`,
          );
        }
      }
    }

    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (name.trim().length === 0) {
        throwApiError(C.DEVICE_MODEL_NAME_REQUIRED, "設備型號名稱不能為空");
      }
      updates.push("name = ?");
      params.push(name.trim());
    }

    if (type_code !== undefined) {
      updates.push("type_code = ?");
      params.push(inputTypeCode || currentTypeCode);
    }

    if (port !== undefined) {
      updates.push("port = ?");
      params.push(parseOptionalInt(port));
    }
    if (unit_id !== undefined) {
      updates.push("unit_id = ?");
      params.push(parseOptionalInt(unit_id));
    }

    if (description !== undefined) {
      updates.push("description = ?");
      params.push(description || null);
    }

    if (category_code !== undefined) {
      const cc =
        category_code != null && String(category_code).trim()
          ? String(category_code).trim()
          : null;
      if (cc && cc.length > 50) {
        throwApiError(
          C.DEVICE_MODEL_CATEGORY_CODE_INVALID,
          "category_code 長度過長",
        );
      }
      updates.push("category_code = ?");
      params.push(cc);
    }

    if (config !== undefined) {
      updates.push("config = ?");
      params.push(stringifyConfig(config));
    }

    if (updates.length === 0) {
      throwApiError(C.DEVICE_MODEL_UPDATE_NO_FIELDS, "沒有提供要更新的欄位");
    }

    params.push(id);

    await db.query(
      `UPDATE device_models SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      params,
    );

    const models = await db.query(
      `
			SELECT 
				dm.*
			FROM device_models dm
			WHERE dm.id = ?
		`,
      [id],
    );

    const model = models[0];
    model.type_name = getDeviceTypeName(model.type_code);
    model.config = parseConfig(model.config);

    return {
      message: "設備型號更新成功",
      device_model: model,
    };
  } catch (error) {
    rethrowIfApiError(error);
    deviceModelLogger.error("更新設備型號失敗", {
      id,
      error: error?.message || String(error),
      module: "deviceModelService",
    });
    failDeviceModelUpdate("更新設備型號失敗", causeDetails(error));
  }
}

async function deleteDeviceModel(id) {
  try {
    const models = await db.query("SELECT id FROM device_models WHERE id = ?", [
      id,
    ]);

    if (models.length === 0) {
      throwApiError(C.DEVICE_MODEL_NOT_FOUND, "設備型號不存在");
    }

    const devices = await db.query(
      "SELECT id FROM devices WHERE model_id = ? LIMIT 1",
      [id],
    );
    if (devices.length > 0) {
      throwApiError(C.DEVICE_MODEL_IN_USE, "無法刪除：仍有設備使用此型號");
    }

    await db.query("DELETE FROM device_models WHERE id = ?", [id]);

    return {
      message: "設備型號已刪除",
    };
  } catch (error) {
    rethrowIfApiError(error);
    deviceModelLogger.error("刪除設備型號失敗", {
      id,
      error: error?.message || String(error),
      module: "deviceModelService",
    });
    failDeviceModelDelete("刪除設備型號失敗", causeDetails(error));
  }
}

module.exports = {
  getAllDeviceModels,
  getDeviceModelById,
  createDeviceModel,
  updateDeviceModel,
  deleteDeviceModel,
};
