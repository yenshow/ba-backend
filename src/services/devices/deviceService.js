const db = require("../../database/db");
const {
  parseConfig,
  stringifyConfig,
  validateDeviceConfig,
  validateLoggingConfig,
} = require("../../utils/deviceHelpers");
const websocketService = require("../websocket/websocketService");
const alertService = require("../alerts/alertService");
const licenseService = require("../licenseService");
const licenseQuotaService = require("../licenseQuotaService");
const mediaMTXConfigSyncService = require("../communication/mediaMTXConfigSyncService");
const logger = require("../../utils/logger");
const {
  normalizeDeviceTypeCode,
  getDeviceTypeName,
} = require("../../constants/deviceTypes");

const deviceLogger = logger.createLogger("deviceService");

// 取得設備列表
async function getDevices(filters = {}) {
  try {
    const {
      type_code,
      status,
      group,
      limit = 20,
      offset = 0,
      orderBy = "created_at",
      order = "desc",
    } = filters;

    let query = `
			SELECT 
				d.*,
				dm.name as model_name
			FROM devices d
			LEFT JOIN device_models dm ON d.model_id = dm.id
			WHERE 1=1
		`;
    const params = [];

    if (type_code) {
      query += " AND d.type_code = ?";
      params.push(type_code);
    }

    if (status) {
      query += " AND d.status = ?";
      params.push(status);
    }

    if (group != null && group !== "") {
      query += " AND d.config->>'group' = ?";
      params.push(group);
    }

    // 排序
    const validOrderBy = ["created_at", "updated_at", "name", "status"];
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

    if (status) {
      countQuery += " AND d.status = ?";
      countParams.push(status);
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
    deviceLogger.error("取得設備列表失敗", {
      error: error?.message || String(error),
      module: "deviceService",
    });
    throw new Error("取得設備列表失敗: " + error.message);
  }
}

// 取得單一設備
async function getDeviceById(id) {
  try {
    const devices = await db.query(
      `
			SELECT 
				d.*,
				dm.id as model_id,
				dm.name as model_name,
				dm.port as model_port,
				dm.config as model_config
			FROM devices d
			LEFT JOIN device_models dm ON d.model_id = dm.id
			WHERE d.id = ?
		`,
      [id],
    );

    if (devices.length === 0) {
      const error = new Error("設備不存在");
      error.statusCode = 404;
      throw error;
    }

    const device = devices[0];
    device.type_name = getDeviceTypeName(device.type_code);
    device.config = parseConfig(device.config);

    // 如果設備有 model_id，包含完整的 model 資訊（含 config）
    if (device.model_id) {
      device.model = {
        id: device.model_id,
        name: device.model_name,
        port: device.model_port,
        config: parseConfig(device.model_config),
      };
    }

    // 移除臨時欄位
    delete device.model_id;
    delete device.model_name;
    delete device.model_port;
    delete device.model_config;

    return { device };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    deviceLogger.error("取得設備失敗", {
      id,
      error: error?.message || String(error),
      module: "deviceService",
    });
    throw new Error("取得設備失敗: " + error.message);
  }
}

// 創建設備
async function createDevice(deviceData, userId) {
  try {
    const { name, type_code, model_id, description, status, config } = deviceData;

    // 驗證必填欄位
    if (!name || name.trim().length === 0) {
      throw new Error("設備名稱不能為空");
    }

    if (name.length > 100) {
      throw new Error("設備名稱長度不能超過 100 字元");
    }

    const inputTypeCode = normalizeDeviceTypeCode(type_code);
    if (!inputTypeCode) {
      throw new Error("設備類型不能為空");
    }

    if (!config) {
      throw new Error("設備配置不能為空");
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
        const err = new Error(`不支援的 system_type：${featureKey}`);
        err.statusCode = 400;
        throw err;
      }

      const openAll = license?.activationMethod === "open_all";
      const licensed =
        Array.isArray(license?.features) && license.features.includes(featureKey);

      if (!openAll && !licensed) {
        const err = new Error(`未授權功能：${featureKey}`);
        err.statusCode = 403;
        err.code = "FEATURE_NOT_LICENSED";
        err.feature = featureKey;
        throw err;
      }

      const rawMax = license?.quotas?.[featureKey]?.maxDevices;
      const max = rawMax == null ? null : Math.floor(Number(rawMax));
      const hasMax = Number.isFinite(max) && max >= 0;

      if (!openAll && hasMax) {
        const used = await licenseQuotaService.getUsedDevicesCount(featureKey);
        if (used >= max) {
          const err = new Error("已達到授權配額上限");
          err.statusCode = 403;
          err.code = "LICENSE_QUOTA_EXCEEDED";
          err.feature = featureKey;
          err.used = used;
          err.max = max;
          throw err;
        }
      }
    }

    // 驗證 model_id 必填
    if (!model_id) {
      throw new Error("設備型號 ID 不能為空");
    }

    // 驗證設備型號是否存在且類型匹配
    const models = await db.query(
      "SELECT id, type_code, port, unit_id FROM device_models WHERE id = ?",
      [model_id],
    );
    if (models.length === 0) {
      throw new Error("設備型號不存在");
    }

    if (String(models[0].type_code || "") !== typeCode) {
      throw new Error("設備型號的類型與設備類型不匹配");
    }

    const modelPort = models[0].port ?? null;
    const modelUnitId = models[0].unit_id ?? null;

    // 驗證配置
    validateDeviceConfig(config, typeCode);

    // 驗證 logging 配置（如果提供）
    if (config.logging) {
      const loggingValidation = validateLoggingConfig(config.logging);
      if (!loggingValidation.valid) {
        throw new Error(`logging 配置驗證失敗: ${loggingValidation.error}`);
      }
    }

    // 對於 controller 類型的設備，處理連接資訊和自動生成 unitId
    if (typeCode === "controller") {
      if (!config.host) {
        throw new Error("controller 類型需要 host (主機位址)");
      }
      if (config.port === undefined && modelPort === null) {
        throw new Error(
          "controller 類型需要 port (端口)，請在型號或設備中填寫",
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
					AND config->>'host' = ? 
					AND (config->>'port')::integer = ?`,
            [typeCode, config.host, finalPort],
          );

          // 找出已使用的 unitId
          const usedUnitIds = new Set();
          existingDevices.forEach((device) => {
            const deviceConfig = parseConfig(device.config);
            if (deviceConfig && deviceConfig.unitId !== undefined) {
              usedUnitIds.add(deviceConfig.unitId);
            }
          });

          // 從 1 開始找第一個未使用的 unitId
          let autoUnitId = 1;
          while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
            autoUnitId++;
          }

          if (autoUnitId > 255) {
            throw new Error("無法自動生成 unitId：已達到最大值 255");
          }

          config.unitId = autoUnitId;
        }
      }

      // 檢查是否已有相同連接配置的設備（host + port + unitId）
      const existing = await db.query(
        `SELECT id FROM devices 
				WHERE type_code = ? 
				AND config->>'host' = ? 
				AND (config->>'port')::integer = ? 
				AND (config->>'unitId')::integer = ?`,
        [typeCode, config.host, finalPort, config.unitId],
      );

      if (existing.length > 0) {
        throw new Error(
          "已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）",
        );
      }
    }

    // 對於 sensor (modbus) 類型的設備，處理連接資訊和自動生成 unitId
    if (typeCode === "sensor" && config.protocol === "modbus") {
      if (!config.host) {
        throw new Error("sensor (modbus) 類型需要 host (主機位址)");
      }
      if (config.port === undefined && modelPort === null) {
        throw new Error(
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
            throw new Error("無法自動生成 unitId：已達到最大值 255");
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
        throw new Error(
          "已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）",
        );
      }
    }

    // 建立設備
    const result = await db.query(
      "INSERT INTO devices (name, type_code, model_id, description, status, config, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      [
        name.trim(),
        typeCode,
        model_id,
        description || null,
        status || "inactive",
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
    if (error.statusCode) {
      throw error;
    }
    deviceLogger.error("創建設備失敗", {
      error: error?.message || String(error),
      module: "deviceService",
    });
    throw new Error("創建設備失敗: " + error.message);
  }
}

// 更新設備
async function updateDevice(id, deviceData, userId) {
  try {
    const { name, model_id, description, status, config, type_code } = deviceData;

    // 檢查設備是否存在
    const existing = await db.query("SELECT * FROM devices WHERE id = ?", [id]);
    if (existing.length === 0) {
      const error = new Error("設備不存在");
      error.statusCode = 404;
      throw error;
    }

    const existingDevice = existing[0];

    // 構建更新欄位
    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (name.trim().length === 0) {
        throw new Error("設備名稱不能為空");
      }
      if (name.length > 100) {
        throw new Error("設備名稱長度不能超過 100 字元");
      }
      updates.push("name = ?");
      params.push(name.trim());
    }

    if (type_code !== undefined) {
      const normalized = normalizeDeviceTypeCode(type_code);
      if (!normalized) {
        throw new Error("設備類型代碼不正確");
      }
      updates.push("type_code = ?");
      params.push(normalized);
    }

    if (model_id !== undefined) {
      // model_id 現在是必填的，不能為 null
      if (!model_id) {
        throw new Error("設備型號 ID 不能為空");
      }

      // 驗證設備型號是否存在
      const models = await db.query(
        "SELECT id, type_code, port, unit_id FROM device_models WHERE id = ?",
        [model_id],
      );
      if (models.length === 0) {
        throw new Error("設備型號不存在");
      }

      // 驗證類型匹配
      const currentTypeCode =
        normalizeDeviceTypeCode(type_code) || String(existingDevice.type_code || "");
      if (String(models[0].type_code || "") !== String(currentTypeCode || "")) {
        throw new Error("設備型號的類型與設備類型不匹配");
      }

      updates.push("model_id = ?");
      params.push(model_id);
    }

    if (description !== undefined) {
      updates.push("description = ?");
      params.push(description || null);
    }

    if (status !== undefined) {
      if (!["active", "inactive", "error"].includes(status)) {
        throw new Error("狀態必須為 active, inactive 或 error");
      }
      updates.push("status = ?");
      params.push(status);
    }

    if (config !== undefined) {
      // 取得當前或新的類型代碼
      const typeCode =
        normalizeDeviceTypeCode(type_code) || String(existingDevice.type_code || "");

      // 驗證配置
      validateDeviceConfig(config, typeCode);

      // 驗證 logging 配置（如果提供）
      if (config.logging) {
        const loggingValidation = validateLoggingConfig(config.logging);
        if (!loggingValidation.valid) {
          throw new Error(`logging 配置驗證失敗: ${loggingValidation.error}`);
        }
      }

      // 對於 controller 類型的設備，處理連接資訊和自動生成 unitId
      if (typeCode === "controller") {
        const existingConfig = parseConfig(existingDevice.config);
        const finalModelId =
          model_id !== undefined ? model_id : existingDevice.model_id;

        // 獲取 model port、unit_id
        let modelPort = null;
        let modelUnitId = null;
        if (finalModelId) {
          const models = await db.query(
            "SELECT port, unit_id FROM device_models WHERE id = ?",
            [finalModelId],
          );
          if (models.length > 0) {
            modelPort = models[0].port ?? null;
            modelUnitId = models[0].unit_id ?? null;
          }
        }

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
							AND config->>'host' = ? 
							AND (config->>'port')::integer = ?`,
                [typeCode, id, finalHost, finalPort],
              );

              // 找出已使用的 unitId
              const usedUnitIds = new Set();
              existingDevices.forEach((device) => {
                const deviceConfig = parseConfig(device.config);
                if (deviceConfig && deviceConfig.unitId !== undefined) {
                  usedUnitIds.add(deviceConfig.unitId);
                }
              });

              // 如果現有設備有 unitId，優先使用
              if (existingConfig && existingConfig.unitId !== undefined) {
                if (!usedUnitIds.has(existingConfig.unitId)) {
                  config.unitId = existingConfig.unitId;
                } else {
                  // 現有的 unitId 已被使用，找新的
                  let autoUnitId = 1;
                  while (usedUnitIds.has(autoUnitId) && autoUnitId <= 255) {
                    autoUnitId++;
                  }
                  if (autoUnitId > 255) {
                    throw new Error("無法自動生成 unitId：已達到最大值 255");
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
                  throw new Error("無法自動生成 unitId：已達到最大值 255");
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
            throw new Error(
              "已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）",
            );
          }
        }
      }

      // 對於 sensor (modbus) 類型的設備，處理連接資訊和自動生成 unitId
      if (typeCode === "sensor" && config.protocol === "modbus") {
        const existingConfig = parseConfig(existingDevice.config);
        const finalModelId =
          model_id !== undefined ? model_id : existingDevice.model_id;

        // 獲取 model port、unit_id
        let modelPort = null;
        let modelUnitId = null;
        if (finalModelId) {
          const models = await db.query(
            "SELECT port, unit_id FROM device_models WHERE id = ?",
            [finalModelId],
          );
          if (models.length > 0) {
            modelPort = models[0].port ?? null;
            modelUnitId = models[0].unit_id ?? null;
          }
        }

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
                    throw new Error("無法自動生成 unitId：已達到最大值 255");
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
                  throw new Error("無法自動生成 unitId：已達到最大值 255");
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
            throw new Error(
              "已存在相同連接配置的設備（相同的 IP、端口和 Unit ID）",
            );
          }
        }
      }

      updates.push("config = ?");
      params.push(stringifyConfig(config));
    }

    if (updates.length === 0) {
      throw new Error("沒有提供要更新的欄位");
    }

    params.push(id);

    // 記錄舊狀態（用於狀態變更事件）
    const oldStatus = existingDevice.status;

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
    const fields = { name, type_code, model_id, description, status, config };
    Object.keys(fields).forEach((key) => {
      if (fields[key] !== undefined) {
        changes[key] = true;
      }
    });

    // 檢測狀態變更並推送特定事件
    const newStatus = status !== undefined ? status : oldStatus;
    if (status !== undefined && oldStatus !== newStatus) {
      // 「停用=全停」：設備被停用時，解決所有既有 active 警示（含 device 與各系統綁定的 location_systems）
      if (newStatus === "inactive") {
        try {
          await alertService.updateAllAlertTypesStatus(
            alertService.ALERT_SOURCES.DEVICE,
            id,
            alertService.ALERT_STATUS.RESOLVED,
            null,
          );

          const linked = await db.query(
            `SELECT id, system_type
             FROM location_systems
             WHERE (
               (system_config->>'device_id' IS NOT NULL AND (system_config->>'device_id')::integer = ?)
               OR (system_config->>'deviceId' IS NOT NULL AND (system_config->>'deviceId')::integer = ?)
               OR (system_config->'device_ids' IS NOT NULL AND system_config->'device_ids' @> ?::jsonb)
             )`,
            [id, id, JSON.stringify([id])],
          );

          const sourceMap = {
            environment: alertService.ALERT_SOURCES.ENVIRONMENT,
            lighting: alertService.ALERT_SOURCES.LIGHTING,
            drainage: alertService.ALERT_SOURCES.DRAINAGE,
            power: alertService.ALERT_SOURCES.POWER,
            fire: alertService.ALERT_SOURCES.FIRE,
            emergency_rescue: alertService.ALERT_SOURCES.EMERGENCY_RESCUE,
          };

          for (const row of linked || []) {
            const src = sourceMap[row.system_type];
            if (!src) continue;
            await alertService.updateAllAlertTypesStatus(
              src,
              Number(row.id),
              alertService.ALERT_STATUS.RESOLVED,
              null,
            );
          }
        } catch (e) {
          deviceLogger.warn("停用設備時解決警示失敗", {
            error: e?.message || String(e),
            module: "deviceService",
          });
        }
      }

      websocketService.emitDeviceStatusChanged({
        deviceId: id,
        oldStatus,
        newStatus,
        userId,
      });
    }

    // 推送設備更新事件（包含所有變更）
    websocketService.emitDeviceUpdated({
      device: updatedDevice.device,
      changes,
      userId,
    });

    return updatedDevice;
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    deviceLogger.error("更新設備失敗", {
      id,
      error: error?.message || String(error),
      module: "deviceService",
    });
    throw new Error("更新設備失敗: " + error.message);
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
      const error = new Error("設備不存在");
      error.statusCode = 404;
      throw error;
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
    if (error.statusCode) {
      throw error;
    }
    deviceLogger.error("刪除設備失敗", {
      id,
      error: error?.message || String(error),
      module: "deviceService",
    });
    throw new Error("刪除設備失敗: " + error.message);
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
    deviceLogger.error("取得攝影機群組失敗", {
      error: error?.message || String(error),
      module: "deviceService",
    });
    throw new Error("取得攝影機群組失敗: " + error.message);
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
