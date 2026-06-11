const db = require("../../database/db");
const {
  parseConfig,
  stringifyConfig,
  validateDeviceConfig,
  validateLoggingConfig,
  isHcnetSdkController,
  ensureControllerHcnetProtocol,
  resolveHcnetSdkPort,
} = require("../../utils/deviceHelpers");
const websocketService = require("../websocket/websocketService");
const licenseService = require("../license/licenseService");
const licenseQuotaService = require("../license/licenseQuotaService");
const mediaMTXConfigSyncService = require("../communication/mediaMTXConfigSyncService");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const { createApiError, throwApiError, causeDetails } = require("../../utils/apiErrorMeta");
const {
  rethrowIfApiError,
  failDeviceList,
  failDeviceGet,
  failDeviceCreate,
  failDeviceUpdate,
  failDeviceDelete,
} = require("../../utils/deviceErrors");
const {
  normalizeDeviceTypeCode,
  getDeviceTypeName,
} = require("../../constants/deviceTypes");

const deviceLogger = logger.createLogger("deviceService");

async function applyControllerConnectionConfig({
  config,
  modelConfig,
  modelPort,
  modelUnitId,
  typeCode,
  existingConfig = null,
  excludeDeviceId = null,
}) {
  const host = String(config.host || existingConfig?.host || "").trim();
  if (!host) {
    throwApiError(
      C.DEVICE_CONTROLLER_HOST_REQUIRED,
      "controller 類型需要 host (主機位址)",
    );
  }
  if (!config.host) config.host = host;

  if (isHcnetSdkController(config, modelConfig)) {
    config.protocol = "hcnet_sdk";
    config.port = resolveHcnetSdkPort(
      { port: config.port ?? existingConfig?.port },
      modelPort,
    );
    delete config.unitId;

    const params = [typeCode, host, config.port];
    let sql = `SELECT id FROM devices 
      WHERE type_code = ? 
      AND config->>'host' = ? 
      AND (config->>'port')::integer = ?`;
    if (excludeDeviceId != null) {
      sql += " AND id != ?";
      params.push(excludeDeviceId);
    }
    const existing = await db.query(sql, params);
    if (existing.length > 0) {
      throwApiError(
        C.DEVICE_DUPLICATE_CONNECTION,
        "已有相同連接配置的設備（host + port）",
      );
    }
    return;
  }

  if (
    config.port === undefined &&
    modelPort === null &&
    existingConfig?.port === undefined
  ) {
    throwApiError(
      C.DEVICE_CONTROLLER_PORT_REQUIRED,
      "controller 類型需要 port (端口)，請在型號或設備中填寫",
    );
  }

  const finalPort = config.port ?? modelPort ?? existingConfig?.port;
  config.port = finalPort;

  if (config.unitId === undefined) {
    if (modelUnitId !== null) {
      config.unitId = modelUnitId;
    } else if (host && finalPort) {
      const params = [typeCode, host, finalPort];
      let sql = `SELECT config FROM devices 
        WHERE type_code = ? 
        AND config->>'host' = ? 
        AND (config->>'port')::integer = ?`;
      if (excludeDeviceId != null) {
        sql += " AND id != ?";
        params.push(excludeDeviceId);
      }
      const existingDevices = await db.query(sql, params);

      const usedUnitIds = new Set();
      existingDevices.forEach((device) => {
        const deviceConfig = parseConfig(device.config);
        if (deviceConfig?.unitId !== undefined) {
          usedUnitIds.add(deviceConfig.unitId);
        }
      });

      const preservedUnitId = existingConfig?.unitId;
      if (preservedUnitId !== undefined && !usedUnitIds.has(preservedUnitId)) {
        config.unitId = preservedUnitId;
      } else {
        let autoUnitId = 1;
        while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
          autoUnitId++;
        }
        if (autoUnitId > 255) {
          throwApiError(
            C.DEVICE_UNIT_ID_EXHAUSTED,
            "無法自動生成 unitId：已達到最大值 255",
          );
        }
        config.unitId = autoUnitId;
      }
    }
  }

  if (
    config.host &&
    config.port !== undefined &&
    config.unitId !== undefined
  ) {
    const params = [typeCode, config.host, config.port, config.unitId];
    let sql = `SELECT id FROM devices 
      WHERE type_code = ? 
      AND config->>'host' = ? 
      AND (config->>'port')::integer = ? 
      AND (config->>'unitId')::integer = ?`;
    if (excludeDeviceId != null) {
      sql += " AND id != ?";
      params.push(excludeDeviceId);
    }
    const existing = await db.query(sql, params);
    if (existing.length > 0) {
      throwApiError(
        C.DEVICE_DUPLICATE_CONNECTION,
        "已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）",
      );
    }
  }
}

// 取得設備列表
async function getDevices(filters = {}) {
  try {
    const {
      type_code,
      group,
      limit = 20,
      offset = 0,
      orderBy = "created_at",
      order = "desc",
    } = filters;

    let query = `
			SELECT 
				d.*,
				dm.name as model_name,
        dm.category_code as model_category_code
			FROM devices d
			LEFT JOIN device_models dm ON d.model_id = dm.id
			WHERE 1=1
		`;
    const params = [];

    if (type_code) {
      query += " AND d.type_code = ?";
      params.push(type_code);
    }

    if (group != null && group !== "") {
      query += " AND d.config->>'group' = ?";
      params.push(group);
    }

    // 排序
    const validOrderBy = ["created_at", "updated_at", "name"];
    const orderByField = validOrderBy.includes(orderBy)
      ? orderBy
      : "created_at";
    const orderDirection = order.toLowerCase() === "asc" ? "ASC" : "DESC";
    query += ` ORDER BY d.${orderByField} ${orderDirection}`;

    // 分頁
    query += " LIMIT ? OFFSET ?";
    params.push(parseInt(limit), parseInt(offset));

    const devices = await db.query(query, params);

    // 取得總數
    let countQuery = `
			SELECT COUNT(*) as total
			FROM devices d
			WHERE 1=1
		`;
    const countParams = [];

    if (type_code) {
      countQuery += " AND d.type_code = ?";
      countParams.push(type_code);
    }

    if (group != null && group !== "") {
      countQuery += " AND d.config->>'group' = ?";
      countParams.push(group);
    }

    const countResult = await db.query(countQuery, countParams);
    const total = countResult[0].total;

    // 解析 config JSON
    const devicesWithConfig = devices.map((device) => ({
      ...device,
      type_name: getDeviceTypeName(device.type_code),
      config: parseConfig(device.config),
    }));

    return {
      devices: devicesWithConfig,
      total: parseInt(total),
      limit: parseInt(limit),
      offset: parseInt(offset),
    };
  } catch (error) {
    rethrowIfApiError(error);
    deviceLogger.error("取得設備列表失敗", {
      error: error?.message || String(error),
      module: "deviceService",
    });
    failDeviceList("取得設備列表失敗", causeDetails(error));
  }
}

// 取得單一設備
async function getDeviceById(id) {
  try {
    const devices = await db.query(
      `
			SELECT 
				d.*,
				dm.name as model_name,
				dm.port as model_port,
        dm.category_code as model_category_code,
				dm.config as model_config
			FROM devices d
			LEFT JOIN device_models dm ON d.model_id = dm.id
			WHERE d.id = ?
		`,
      [id],
    );

    if (devices.length === 0) {
      throwApiError(C.DEVICE_NOT_FOUND, "設備不存在");
    }

    const device = devices[0];
    device.type_name = getDeviceTypeName(device.type_code);
    device.config = parseConfig(device.config);

    if (device.model_id) {
      device.model = {
        id: device.model_id,
        name: device.model_name,
        port: device.model_port,
        category_code: device.model_category_code,
        config: parseConfig(device.model_config),
      };
    }

    delete device.model_port;
    delete device.model_config;

    return { device };
  } catch (error) {
    rethrowIfApiError(error);
    deviceLogger.error("取得設備失敗", {
      id,
      error: error?.message || String(error),
      module: "deviceService",
    });
    failDeviceGet("取得設備失敗", causeDetails(error));
  }
}

// 創建設備
async function createDevice(deviceData, userId) {
  try {
    const { name, type_code, model_id, description, config } = deviceData;

    // 驗證必填欄位
    if (!name || name.trim().length === 0) {
      throwApiError(C.DEVICE_NAME_REQUIRED, "設備名稱不能為空");
    }

    if (name.length > 100) {
      throwApiError(C.DEVICE_NAME_TOO_LONG, "設備名稱長度不能超過 100 字元");
    }

    const inputTypeCode = normalizeDeviceTypeCode(type_code);
    if (!inputTypeCode) {
      throwApiError(C.DEVICE_TYPE_REQUIRED, "設備類型不能為空");
    }

    if (!config) {
      throwApiError(C.DEVICE_CONFIG_REQUIRED, "設備配置不能為空");
    }

    const typeCode = inputTypeCode;

    // Quota/授權：決定此設備歸屬的 feature key（若可判定）
    const inputSystemType =
      typeof deviceData?.system_type === "string"
        ? deviceData.system_type
        : typeof deviceData?.systemType === "string"
          ? deviceData.systemType
          : typeof config?.systemType === "string"
            ? config.systemType
            : null;

    // controller 的 Quota/授權改以 location_systems 綁定時檢查（做法 B）。
    // 因此建立 controller 設備本身不再要求 system_type，也不在此做 quota 檢查。
    const featureKey =
      typeCode === "controller"
        ? null
        : licenseQuotaService.resolveDeviceFeatureKey({
            typeCode,
            systemType: inputSystemType,
          });

    // 若能判定 feature，則做授權與 quota 檢查（openAll 時略過）
    if (featureKey) {
      const license = await licenseService.getLicenseState();
      const activeKeys = licenseService.getActiveFeatureKeys();

      if (!activeKeys.includes(featureKey)) {
        throw createApiError(
          C.DEVICE_UNSUPPORTED_FEATURE,
          `不支援的 system_type：${featureKey}`,
        );
      }

      const openAll = license?.activationMethod === "open_all";
      const licensed =
        Array.isArray(license?.features) && license.features.includes(featureKey);

      if (!openAll && !licensed) {
        throw createApiError(C.FEATURE_NOT_LICENSED, `未授權功能：${featureKey}`, {
          details: { feature: featureKey },
        });
      }

      const rawMax = license?.quotas?.[featureKey]?.maxDevices;
      const max = rawMax == null ? null : Math.floor(Number(rawMax));
      const hasMax = Number.isFinite(max) && max >= 0;

      if (!openAll && hasMax) {
        const used = await licenseQuotaService.getUsedDevicesCount(featureKey);
        if (used >= max) {
          throw createApiError(C.LICENSE_QUOTA_EXCEEDED, "已達到授權配額上限", {
            details: { feature: featureKey, used, max },
          });
        }
      }
    }

    // 驗證 model_id 必填
    if (!model_id) {
      throwApiError(C.DEVICE_MODEL_ID_REQUIRED, "設備型號 ID 不能為空");
    }

    // 驗證設備型號是否存在且類型匹配
    const models = await db.query(
      "SELECT id, type_code, port, unit_id, config FROM device_models WHERE id = ?",
      [model_id],
    );
    if (models.length === 0) {
      throwApiError(C.DEVICE_MODEL_NOT_FOUND, "設備型號不存在");
    }

    if (String(models[0].type_code || "") !== typeCode) {
      throwApiError(
        C.DEVICE_MODEL_TYPE_MISMATCH,
        "設備型號的類型與設備類型不匹配",
      );
    }

    const modelPort = models[0].port ?? null;
    const modelUnitId = models[0].unit_id ?? null;
    const modelConfig = parseConfig(models[0].config) || {};

    if (typeCode === "controller") {
      ensureControllerHcnetProtocol(config, modelConfig);
    }

    // 驗證配置
    validateDeviceConfig(config, typeCode);

    // 驗證 logging 配置（如果提供）
    if (config.logging) {
      const loggingValidation = validateLoggingConfig(config.logging);
      if (!loggingValidation.valid) {
        throwApiError(
          C.DEVICE_LOGGING_CONFIG_INVALID,
          `logging 配置驗證失敗: ${loggingValidation.error}`,
        );
      }
    }

    if (typeCode === "controller") {
      await applyControllerConnectionConfig({
        config,
        modelConfig,
        modelPort,
        modelUnitId,
        typeCode,
      });
    }

    // 對於 sensor (modbus) 類型的設備，處理連接資訊和自動生成 unitId
    if (typeCode === "sensor" && config.protocol === "modbus") {
      if (!config.host) {
        throwApiError(
          C.DEVICE_SENSOR_HOST_REQUIRED,
          "sensor (modbus) 類型需要 host (主機位址)",
        );
      }
      if (config.port === undefined && modelPort === null) {
        throwApiError(
          C.DEVICE_SENSOR_PORT_REQUIRED,
          "sensor (modbus) 類型需要 port (端口)，請在型號或設備中填寫",
        );
      }

      // 設定 port（優先使用 config.port，否則使用 model.port；不再預設 502）
      const finalPort = config.port !== undefined ? config.port : modelPort;
      config.port = finalPort;

      // 使用型號的 unit_id 或自動生成 unitId（如果未提供）
      if (config.unitId === undefined) {
        if (modelUnitId !== null) {
          config.unitId = modelUnitId;
        } else {
          // 查詢相同 host + port 的設備，找出已使用的 unitId
          const existingDevices = await db.query(
            `SELECT config FROM devices 
					WHERE type_code = ? 
					AND config->>'protocol' = 'modbus'
					AND config->>'host' = ? 
					AND (config->>'port')::integer = ?`,
            [typeCode, config.host, finalPort],
          );

          // 找出已使用的 unitId
          const usedUnitIds = new Set();
          existingDevices.forEach((device) => {
            const deviceConfig = parseConfig(device.config);
            if (
              deviceConfig &&
              deviceConfig.protocol === "modbus" &&
              deviceConfig.unitId !== undefined
            ) {
              usedUnitIds.add(deviceConfig.unitId);
            }
          });

          // 從 1 開始找第一個未使用的 unitId
          let autoUnitId = 1;
          while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
            autoUnitId++;
          }

          if (autoUnitId > 255) {
            throwApiError(
              C.DEVICE_UNIT_ID_EXHAUSTED,
              "無法自動生成 unitId：已達到最大值 255",
            );
          }

          config.unitId = autoUnitId;
        }
      }

      // 檢查是否已有相同連接配置的設備（host + port + unitId）
      const existing = await db.query(
        `SELECT id FROM devices 
				WHERE type_code = ? 
				AND config->>'protocol' = 'modbus'
				AND config->>'host' = ? 
				AND (config->>'port')::integer = ? 
				AND (config->>'unitId')::integer = ?`,
        [typeCode, config.host, finalPort, config.unitId],
      );

      if (existing.length > 0) {
        throwApiError(
          C.DEVICE_DUPLICATE_CONNECTION,
          "已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）",
        );
      }
    }

    // 建立設備
    const result = await db.query(
      "INSERT INTO devices (name, type_code, model_id, description, config, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      [
        name.trim(),
        typeCode,
        model_id,
        description || null,
        stringifyConfig(config),
        userId || null,
      ],
    );

    // 取得建立的設備
    const deviceResult = await getDeviceById(result[0].id);

    // 攝影機：自動套用到 MediaMTX（立即更新 + 產生 generated 檔供下次啟動）
    try {
      if (String(deviceResult?.device?.type_code || "").toLowerCase() === "camera") {
        const rtspUrl = String(deviceResult?.device?.config?.rtsp_url || "").trim();
        if (rtspUrl) {
          await mediaMTXConfigSyncService.syncSingleCameraPath(deviceResult.device.id, rtspUrl);
          await mediaMTXConfigSyncService.generateConfigFile();
        }
      }
    } catch (e) {
      deviceLogger.warn("同步 MediaMTX 失敗（createDevice）", {
        deviceId: deviceResult?.device?.id,
        error: e?.message || String(e),
        module: "deviceService",
      });
    }

    // 推送 WebSocket 事件：設備創建
    websocketService.emitDeviceCreated({
      device: deviceResult.device,
      userId,
    });

    return deviceResult;
  } catch (error) {
    rethrowIfApiError(error);
    deviceLogger.error("創建設備失敗", {
      error: error?.message || String(error),
      module: "deviceService",
    });
    failDeviceCreate("創建設備失敗", causeDetails(error));
  }
}

// 更新設備
async function updateDevice(id, deviceData, userId) {
  try {
    const { name, model_id, description, config, type_code } = deviceData;

    // 檢查設備是否存在
    const existing = await db.query("SELECT * FROM devices WHERE id = ?", [id]);
    if (existing.length === 0) {
      throwApiError(C.DEVICE_NOT_FOUND, "設備不存在");
    }

    const existingDevice = existing[0];

    // 構建更新欄位
    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (name.trim().length === 0) {
        throwApiError(C.DEVICE_NAME_REQUIRED, "設備名稱不能為空");
      }
      if (name.length > 100) {
        throwApiError(C.DEVICE_NAME_TOO_LONG, "設備名稱長度不能超過 100 字元");
      }
      updates.push("name = ?");
      params.push(name.trim());
    }

    if (type_code !== undefined) {
      const normalized = normalizeDeviceTypeCode(type_code);
      if (!normalized) {
        throwApiError(C.DEVICE_TYPE_INVALID, "設備類型代碼不正確");
      }
      updates.push("type_code = ?");
      params.push(normalized);
    }

    if (model_id !== undefined) {
      // model_id 現在是必填的，不能為 null
      if (!model_id) {
        throwApiError(C.DEVICE_MODEL_ID_REQUIRED, "設備型號 ID 不能為空");
      }

      // 驗證設備型號是否存在
      const models = await db.query(
        "SELECT id, type_code, port, unit_id FROM device_models WHERE id = ?",
        [model_id],
      );
      if (models.length === 0) {
        throwApiError(C.DEVICE_MODEL_NOT_FOUND, "設備型號不存在");
      }

      // 驗證類型匹配
      const currentTypeCode =
        normalizeDeviceTypeCode(type_code) || String(existingDevice.type_code || "");
      if (String(models[0].type_code || "") !== String(currentTypeCode || "")) {
        throwApiError(
          C.DEVICE_MODEL_TYPE_MISMATCH,
          "設備型號的類型與設備類型不匹配",
        );
      }

      updates.push("model_id = ?");
      params.push(model_id);
    }

    if (description !== undefined) {
      updates.push("description = ?");
      params.push(description || null);
    }

    if (config !== undefined) {
      // 取得當前或新的類型代碼
      const typeCode =
        normalizeDeviceTypeCode(type_code) || String(existingDevice.type_code || "");

      const existingConfig = parseConfig(existingDevice.config);
      const finalModelId =
        model_id !== undefined ? model_id : existingDevice.model_id;

      let modelPort = null;
      let modelUnitId = null;
      let modelConfig = {};
      if (finalModelId) {
        const models = await db.query(
          "SELECT port, unit_id, config FROM device_models WHERE id = ?",
          [finalModelId],
        );
        if (models.length > 0) {
          modelPort = models[0].port ?? null;
          modelUnitId = models[0].unit_id ?? null;
          modelConfig = parseConfig(models[0].config) || {};
        }
      }

      if (typeCode === "controller") {
        ensureControllerHcnetProtocol(config, modelConfig);
      }

      // 驗證配置
      validateDeviceConfig(config, typeCode);

      // 驗證 logging 配置（如果提供）
      if (config.logging) {
        const loggingValidation = validateLoggingConfig(config.logging);
        if (!loggingValidation.valid) {
          throwApiError(
            C.DEVICE_LOGGING_CONFIG_INVALID,
            `logging 配置驗證失敗: ${loggingValidation.error}`,
          );
        }
      }

      if (typeCode === "controller") {
        await applyControllerConnectionConfig({
          config,
          modelConfig,
          modelPort,
          modelUnitId,
          typeCode,
          existingConfig,
          excludeDeviceId: id,
        });
      }

      // 對於 sensor (modbus) 類型的設備，處理連接資訊和自動生成 unitId
      if (typeCode === "sensor" && config.protocol === "modbus") {
        // 設定 port（優先 config → model → 現有；不再預設 502）
        const finalPort =
          config.port !== undefined
            ? config.port
            : (modelPort ?? existingConfig?.port);
        config.port = finalPort;

        // 使用型號的 unit_id 或自動生成 unitId（如果未提供）
        if (config.unitId === undefined) {
          if (modelUnitId !== null) {
            config.unitId = modelUnitId;
          } else {
            const finalHost = config.host || existingConfig?.host;

            if (finalHost && finalPort) {
              // 查詢相同 host + port 的設備，找出已使用的 unitId（排除當前設備）
              const existingDevices = await db.query(
                `SELECT config FROM devices 
							WHERE type_code = ? 
							AND id != ?
							AND config->>'protocol' = 'modbus'
							AND config->>'host' = ? 
							AND (config->>'port')::integer = ?`,
                [typeCode, id, finalHost, finalPort],
              );

              // 找出已使用的 unitId
              const usedUnitIds = new Set();
              existingDevices.forEach((device) => {
                const deviceConfig = parseConfig(device.config);
                if (
                  deviceConfig &&
                  deviceConfig.protocol === "modbus" &&
                  deviceConfig.unitId !== undefined
                ) {
                  usedUnitIds.add(deviceConfig.unitId);
                }
              });

              // 如果現有設備有 unitId，優先使用
              if (
                existingConfig &&
                existingConfig.protocol === "modbus" &&
                existingConfig.unitId !== undefined
              ) {
                if (!usedUnitIds.has(existingConfig.unitId)) {
                  config.unitId = existingConfig.unitId;
                } else {
                  // 現有的 unitId 已被使用，找新的
                  let autoUnitId = 1;
                  while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
                    autoUnitId++;
                  }
                  if (autoUnitId > 255) {
                    throwApiError(
                      C.DEVICE_UNIT_ID_EXHAUSTED,
                      "無法自動生成 unitId：已達到最大值 255",
                    );
                  }
                  config.unitId = autoUnitId;
                }
              } else {
                // 從 1 開始找第一個未使用的 unitId
                let autoUnitId = 1;
                while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
                  autoUnitId++;
                }
                if (autoUnitId > 255) {
                  throwApiError(
                    C.DEVICE_UNIT_ID_EXHAUSTED,
                    "無法自動生成 unitId：已達到最大值 255",
                  );
                }
                config.unitId = autoUnitId;
              }
            }
          }
        }

        // 檢查是否已有相同連接配置的設備（host + port + unitId，排除當前設備）
        if (
          config.host &&
          config.port !== undefined &&
          config.unitId !== undefined
        ) {
          const existing = await db.query(
            `SELECT id FROM devices 
						WHERE type_code = ? 
						AND id != ?
						AND config->>'host' = ? 
						AND (config->>'port')::integer = ? 
						AND (config->>'unitId')::integer = ?`,
            [typeCode, id, config.host, config.port, config.unitId],
          );

          if (existing.length > 0) {
            throwApiError(
              C.DEVICE_DUPLICATE_CONNECTION,
              "已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）",
            );
          }
        }
      }

      updates.push("config = ?");
      params.push(stringifyConfig(config));
    }

    if (updates.length === 0) {
      throwApiError(C.DEVICE_UPDATE_NO_FIELDS, "沒有提供要更新的欄位");
    }

    params.push(id);

    await db.query(
      `UPDATE devices SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      params,
    );

    // 取得更新後的設備
    const updatedDevice = await getDeviceById(id);

    // 攝影機：若 rtsp_url 變更，立即同步到 MediaMTX + 更新 generated 檔
    try {
      if (String(updatedDevice?.device?.type_code || "").toLowerCase() === "camera") {
        const rtspUrl = String(updatedDevice?.device?.config?.rtsp_url || "").trim();
        if (rtspUrl) {
          await mediaMTXConfigSyncService.syncSingleCameraPath(updatedDevice.device.id, rtspUrl);
        }
        await mediaMTXConfigSyncService.generateConfigFile();
      }
    } catch (e) {
      deviceLogger.warn("同步 MediaMTX 失敗（updateDevice）", {
        deviceId: updatedDevice?.device?.id,
        error: e?.message || String(e),
        module: "deviceService",
      });
    }

    // 構建變更的欄位列表
    const changes = {};
    const fields = { name, type_code, model_id, description, config };
    Object.keys(fields).forEach((key) => {
      if (fields[key] !== undefined) {
        changes[key] = true;
      }
    });

    // 推送設備更新事件（包含所有變更）
    websocketService.emitDeviceUpdated({
      device: updatedDevice.device,
      changes,
      userId,
    });

    return updatedDevice;
  } catch (error) {
    rethrowIfApiError(error);
    deviceLogger.error("更新設備失敗", {
      id,
      error: error?.message || String(error),
      module: "deviceService",
    });
    failDeviceUpdate("更新設備失敗", causeDetails(error));
  }
}

// 刪除設備
async function deleteDevice(id, userId = null) {
  try {
    // 檢查設備是否存在
    const devices = await db.query(
      `
      SELECT d.id, d.type_code, d.config
      FROM devices d
      WHERE d.id = ?
      LIMIT 1
      `,
      [id]
    );
    if (devices.length === 0) {
      throwApiError(C.DEVICE_NOT_FOUND, "設備不存在");
    }

    const isCamera = String(devices[0]?.type_code || "").toLowerCase() === "camera";
    await db.query("DELETE FROM devices WHERE id = ?", [id]);

    // 攝影機：刪除後更新 generated 檔（runtime 不主動 removePath，避免 reload）
    try {
      if (isCamera) {
        await mediaMTXConfigSyncService.generateConfigFile();
      }
    } catch (e) {
      deviceLogger.warn("同步 MediaMTX 失敗（deleteDevice）", {
        deviceId: id,
        error: e?.message || String(e),
        module: "deviceService",
      });
    }

    // 推送 WebSocket 事件：設備刪除
    websocketService.emitDeviceDeleted({
      deviceId: id,
      userId,
    });

    return { message: "設備已刪除" };
  } catch (error) {
    rethrowIfApiError(error);
    deviceLogger.error("刪除設備失敗", {
      id,
      error: error?.message || String(error),
      module: "deviceService",
    });
    failDeviceDelete("刪除設備失敗", causeDetails(error));
  }
}

// 取得攝影機群組列表（不重複，供篩選下拉使用）
async function getCameraGroups() {
  try {
    const query = `
      SELECT DISTINCT d.config->>'group' AS group_name
      FROM devices d
      WHERE d.type_code = ?
        AND d.config->>'group' IS NOT NULL
        AND TRIM(d.config->>'group') != ''
      ORDER BY 1
    `;
    const rows = await db.query(query, ["camera"]);
    return rows.map((r) => r.group_name).filter(Boolean);
  } catch (error) {
    rethrowIfApiError(error);
    deviceLogger.error("取得攝影機群組失敗", {
      error: error?.message || String(error),
      module: "deviceService",
    });
    throwApiError(C.DEVICE_CAMERA_GROUPS_FAILED, "取得攝影機群組失敗", {
      statusCode: 500,
      details: causeDetails(error),
    });
  }
}

module.exports = {
  getDevices,
  getCameraGroups,
  getDeviceById,
  createDevice,
  updateDevice,
  deleteDevice,
};
