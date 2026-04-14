/**
 * 環境系統監控任務
 * 定期檢查所有環境位置的感測器設備狀態
 */

const db = require("../../database/db");
const modbusBatchService = require("../devices/modbusBatchService");
const systemAlert = require("../alerts/systemAlertHelper");
const websocketService = require("../websocket/websocketService");
const alertRuleService = require("../alerts/alertRuleService");
const alertService = require("../alerts/alertService");
const deviceLoggingConfig = require("../devices/deviceLoggingConfig");
const environmentReadingsService = require("../systems/environmentReadingsService");
const logger = require("../../utils/logger");

// 追蹤上次的設備狀態，只在狀態改變時才推送 WebSocket 事件（優化：減少不必要的推送）
const lastDeviceStatus = new Map(); // key: `${system}:${sourceId}`, value: 'online' | 'offline'

// 每 5 分鐘才寫入一筆 raw 至 DB（設計：ENVIRONMENT_DATA_DESIGN.md）
const RAW_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const lastRawWriteByLocation = new Map(); // key: location_id, value: timestamp

/** 依 register_type 分組讀取 Modbus（FC01～FC04），合併為 deviceValues */
async function readValuesByRegisterType(enabledValues, deviceConfig) {
  const deviceValues = {};
  const registerTypes = [
    { type: "holding", batchType: "holding" },
    { type: "input", batchType: "input" },
    { type: "coils", batchType: "coil" },
    { type: "discrete", batchType: "discrete" },
  ];

  for (const { type: registerType, batchType } of registerTypes) {
    const group = enabledValues.filter(
      (v) => (v.register_type || "holding") === registerType,
    );
    if (group.length === 0) continue;

    let minAddress = group[0].address;
    let maxAddress = group[0].address + (group[0].length || 1);
    for (const vc of group) {
      const endAddr = vc.address + (vc.length || 1);
      minAddress = Math.min(minAddress, vc.address);
      maxAddress = Math.max(maxAddress, endAddr);
    }
    const readLength = maxAddress - minAddress;
    if (readLength <= 0) continue;

    let modbusData;
    try {
      const results = await modbusBatchService.batchRead([
        {
          host: deviceConfig.host,
          port: deviceConfig.port,
          unitId: deviceConfig.unitId,
          registerType: batchType,
          address: minAddress,
          length: readLength,
          meta: { registerType },
        },
      ]);
      const first = results?.[0];
      if (!first || first.ok !== true) {
        throw new Error(first?.error || "讀取失敗");
      }
      modbusData = first.data;
    } catch (err) {
      logger.warn(`environmentMonitor: 讀取 ${registerType} 失敗`, {
        error: err.message,
        minAddress,
        readLength,
      });
      continue;
    }

    for (const valueConfig of group) {
      const relativeAddress = valueConfig.address - minAddress;
      const rawValue =
        Array.isArray(modbusData) &&
        relativeAddress >= 0 &&
        relativeAddress < modbusData.length
          ? valueConfig.length === 1
            ? modbusData[relativeAddress]
            : modbusData.slice(
                relativeAddress,
                relativeAddress + (valueConfig.length || 1),
              )
          : null;

      if (rawValue !== null && rawValue !== undefined) {
        const convertedValue = deviceLoggingConfig.applyConversion(
          rawValue,
          valueConfig.conversion,
        );
        deviceValues[valueConfig.name] = {
          value: convertedValue,
          unit: valueConfig.conversion?.unit || null,
        };
      }
    }
  }

  return deviceValues;
}

/**
 * 檢查環境位置的感測器狀態（支援一地點多台設備 device_ids）
 */
async function checkEnvironmentLocations() {
  try {
    // 取得所有環境監測地點（含 system_config，不 join devices）
    const rows = await db.query(`
			SELECT 
				l.id as location_id,
				l.name as location_name,
				l.zone_id,
				z.name as zone_name,
				ls.id as system_id,
				ls.system_config
			FROM locations l
			INNER JOIN zones z ON l.zone_id = z.id
			INNER JOIN location_systems ls ON l.id = ls.location_id
			WHERE ls.system_type = 'environment'
		`);

    // 解析 system_config，展開為 (location, device_id) 清單
    const locationDevicePairs = [];
    const allDeviceIds = new Set();
    for (const row of rows) {
      const config =
        typeof row.system_config === "string"
          ? JSON.parse(row.system_config || "{}")
          : row.system_config || {};
      const deviceIds = Array.isArray(config.device_ids)
        ? config.device_ids
            .map((id) => parseInt(id, 10))
            .filter((n) => !Number.isNaN(n))
        : config.device_id != null && config.device_id !== ""
          ? [parseInt(String(config.device_id), 10)]
          : [];
      for (const deviceId of deviceIds) {
        if (Number.isNaN(deviceId)) continue;
        allDeviceIds.add(deviceId);
        locationDevicePairs.push({
          location_id: row.location_id,
          location_name: row.location_name,
          zone_id: row.zone_id,
          zone_name: row.zone_name,
          system_id: row.system_id,
          device_id: deviceId,
        });
      }
    }

    if (locationDevicePairs.length === 0) {
      return;
    }

    // 一次查詢所有設備的 config 與 type
    const deviceIdList = Array.from(allDeviceIds);
    const devices =
      deviceIdList.length === 0
        ? []
        : await db.query(
            `SELECT d.id, d.config as device_config
             FROM devices d
             INNER JOIN device_types dt ON d.type_id = dt.id
             WHERE d.id = ANY($1::int[])
               AND d.status = 'active'
               AND dt.code = 'sensor'
               AND d.config->>'protocol' = 'modbus'`,
            [deviceIdList],
          );
    const deviceConfigMap = new Map(
      devices.map((d) => [d.id, d.device_config]),
    );

    const locations = locationDevicePairs
      .map((pair) => {
        const deviceConfig = deviceConfigMap.get(pair.device_id);
        if (!deviceConfig) return null;
        return {
          ...pair,
          device_config: deviceConfig,
        };
      })
      .filter(Boolean);

    if (locations.length === 0) {
      return;
    }

    let successCount = 0;
    let failCount = 0;

    // 併發控制由 modbusClient（全域 limiter）統一處理
    const checkPromises = locations.map(async (location) => {
      try {
        const deviceConfigRaw =
          typeof location.device_config === "string"
            ? JSON.parse(location.device_config)
            : location.device_config;

        if (!deviceConfigRaw.host || !deviceConfigRaw.port) {
          return {
            systemId: location.system_id,
            locationId: location.location_id,
            success: false,
            reason: "配置不完整",
          };
        }

        const deviceConfig = {
          host: deviceConfigRaw.host,
          port: deviceConfigRaw.port,
          unitId: deviceConfigRaw.unitId || 1,
        };

        // 嘗試讀取第一個保持寄存器（地址 0）來檢查設備狀態
        // 這是一個輕量級的檢查，不會讀取大量數據
        {
          const results = await modbusBatchService.batchRead([
            {
              host: deviceConfig.host,
              port: deviceConfig.port,
              unitId: deviceConfig.unitId,
              registerType: "holding",
              address: 0,
              length: 1,
              meta: { health: true, systemId: location.system_id },
            },
          ]);
          const first = results?.[0];
          if (!first || first.ok !== true) {
            throw new Error(first?.error || "設備離線");
          }
        }

        // 讀取成功，清除錯誤狀態（使用 location_systems.id，批次模式：跳過即時推送）
        await systemAlert.clearError("environment", location.system_id, {
          skipWebSocket: true,
        });

        // 記錄設備數值（如果設備配置了 logging）
        let sensorDataForThreshold = null;
        const deviceId = location.device_id
          ? parseInt(location.device_id)
          : null;
        if (deviceId) {
          try {
            const loggingConfig =
              await deviceLoggingConfig.getDeviceLoggingConfig(deviceId);

            if (
              loggingConfig.enabled &&
              loggingConfig.values &&
              loggingConfig.values.length > 0
            ) {
              const enabledValues = loggingConfig.values.filter(
                (v) => v.enabled,
              );
              const deviceValues = await readValuesByRegisterType(
                enabledValues,
                deviceConfig,
              );

              if (Object.keys(deviceValues).length > 0) {
                const data = {};
                for (const [name, obj] of Object.entries(deviceValues)) {
                  data[name] = obj?.value ?? null;
                }
                const dataRounded =
                  environmentReadingsService.roundDataToOneDecimal(data);
                sensorDataForThreshold = dataRounded;
                const ts = new Date().toISOString();
                const now = Date.now();
                const rawKey = `${location.location_id}:${deviceId}`;
                const lastWrite = lastRawWriteByLocation.get(rawKey);
                const shouldWriteRaw =
                  lastWrite === undefined ||
                  now - lastWrite >= RAW_WRITE_INTERVAL_MS;
                if (shouldWriteRaw) {
                  environmentReadingsService
                    .saveReading({
                      locationId: location.location_id,
                      sourceId: location.system_id,
                      deviceId: deviceId,
                      data,
                    })
                    .then(() => {
                      lastRawWriteByLocation.set(rawKey, now);
                    })
                    .catch((error) => {
                      logger.error(
                        `記錄環境讀數失敗 (locationId: ${location.location_id})`,
                        {
                          error: error.message,
                          locationId: location.location_id,
                          module: "environmentMonitor",
                        },
                      );
                    });
                }
                websocketService.emitEnvironmentReading({
                  locationId: location.location_id,
                  reading: {
                    id: `monitor_${location.location_id}_${Date.now()}`,
                    locationId: String(location.location_id),
                    timestamp: ts,
                    data: dataRounded,
                    createdAt: ts,
                  },
                });
              }
            }
          } catch (logError) {
            // 記錄失敗不影響監控流程
            logger.error(`記錄設備數值失敗 (deviceId: ${deviceId})`, {
              error: logError.message,
              deviceId,
              module: "environmentMonitor",
            });
          }
        }

        // 讀取成功後，檢查閾值（僅在設備連接正常時）
        // 優先用「本次即時讀取」資料；若無（例如 logging 未啟用），再回退用 environment_readings
        try {
          if (!deviceId) {
            return {
              systemId: location.system_id,
              locationId: location.location_id,
              success: true,
            };
          }

          if (sensorDataForThreshold) {
            await checkAndResolveThresholds(location.system_id, sensorDataForThreshold, {
              name: location.location_name,
              zone_name: location.zone_name,
            });
          } else {
            const latestReading = await db.query(
              `SELECT data
               FROM environment_readings
               WHERE location_id = $1
                 AND recorded_at >= NOW() - INTERVAL '10 minutes'
               ORDER BY recorded_at DESC
               LIMIT 1`,
              [location.location_id],
            );

            if (
              latestReading &&
              latestReading.length > 0 &&
              latestReading[0].data
            ) {
              const sensorData =
                typeof latestReading[0].data === "object"
                  ? latestReading[0].data
                  : JSON.parse(latestReading[0].data || "{}");

              // 調試日誌：只在需要時輸出（可通過環境變數控制）
              // 設置 ENABLE_DETAILED_LOGS=true 來啟用詳細日誌
              if (process.env.ENABLE_DETAILED_LOGS === "true") {
                logger.debug(
                  `位置 ${location.location_id} (${location.location_name}) 感測器數據`,
                  {
                    locationId: location.location_id,
                    locationName: location.location_name,
                    sensorData,
                    module: "environmentMonitor",
                  },
                );
              }

              // 檢查閾值並自動解決恢復正常的警報（使用 location_systems.id）
              await checkAndResolveThresholds(location.system_id, sensorData, {
                name: location.location_name,
                zone_name: location.zone_name,
              });
            }
          }
        } catch (thresholdError) {
          // 閾值檢查失敗不影響連線檢查結果
          logger.error(`檢查位置 ${location.location_id} 閾值失敗`, {
            error: thresholdError.message,
            locationId: location.location_id,
            module: "environmentMonitor",
          });
        }

        return {
          systemId: location.system_id,
          locationId: location.location_id,
          success: true,
        };
      } catch (error) {
        // 讀取失敗，記錄錯誤（不檢查閾值）（批次模式：跳過即時推送）
        // 使用 location_systems.id 作為 source_id
        const errorMessage = error.message || "無法讀取感測器資料";
        await systemAlert.recordError(
          "environment",
          location.system_id,
          errorMessage,
          { skipWebSocket: true },
        );

        return {
          systemId: location.system_id,
          locationId: location.location_id,
          success: false,
          reason: errorMessage,
        };
      }
    });

    const results = await Promise.allSettled(checkPromises);

    // 計數：每個 (location, device) 的成敗
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (result.value.success) successCount++;
        else failCount++;
      } else {
        failCount++;
        const location = locations[index];
        if (location) {
          logger.error("檢查位置失敗 (Promise rejected)", {
            error: result.reason?.message || result.reason,
            locationId: location.location_id,
            deviceId: location.device_id,
            module: "environmentMonitor",
          });
        }
      }
    });

    // 依 system_id 彙總：該地點只要有一台設備成功即視為 online
    const systemSuccess = new Map();
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const loc = locations[index];
      if (!loc) return;
      const sid = loc.system_id;
      const ok = result.value.success;
      if (!systemSuccess.has(sid)) systemSuccess.set(sid, false);
      if (ok) systemSuccess.set(sid, true);
    });

    const statusUpdates = [];
    systemSuccess.forEach((anySuccess, systemId) => {
      const currentStatus = anySuccess ? "online" : "offline";
      const key = `environment:${systemId}`;
      const lastStatus = lastDeviceStatus.get(key);
      if (lastStatus !== currentStatus) {
        lastDeviceStatus.set(key, currentStatus);
        const loc = locations.find((l) => l.system_id === systemId);
        statusUpdates.push({
          system: "environment",
          sourceId: systemId,
          deviceId: loc?.device_id ?? null,
          status: currentStatus,
        });
      }
    });

    // 批次推送設備狀態更新（只推送狀態改變的設備）
    if (statusUpdates.length > 0) {
      websocketService.emitBatchDeviceStatus(statusUpdates);
    }

    if (successCount > 0 || failCount > 0) {
      logger.info(`檢查完成: 成功 ${successCount} 個，失敗 ${failCount} 個`, {
        successCount,
        failCount,
        module: "environmentMonitor",
      });
    }
  } catch (error) {
    logger.error("檢查環境位置失敗", {
      error,
      module: "environmentMonitor",
    });
    // 不重新拋出錯誤，由 backgroundMonitor 統一處理
  }
}

/**
 * 解決閾值警報（統一函數，減少重複代碼）
 * @param {number} systemId - 地點系統 ID
 * @param {string} parameter - 參數名稱
 * @param {number} value - 當前數值
 * @param {string} reason - 解決原因
 * @returns {Promise<void>}
 */
async function resolveThresholdAlert(
  systemId,
  parameter,
  value,
  reason = "數值已恢復正常",
) {
  try {
    const dimensionKey = `threshold:${String(parameter).toLowerCase()}`;
    await alertService.updateAlertStatus(
      systemId,
      alertService.ALERT_SOURCES.ENVIRONMENT,
      "threshold",
      alertService.ALERT_STATUS.RESOLVED,
      null,
      { dimensionKey },
    );

    // 只在啟用詳細日誌時輸出
    if (process.env.ENABLE_DETAILED_LOGS === "true") {
      logger.debug(
        `解決警報 | 系統 ${systemId} | 參數 ${parameter} | 數值: ${value} (${reason})`,
        {
          systemId,
          parameter,
          value,
          reason,
          module: "environmentMonitor",
        },
      );
    }
  } catch (error) {
    // 如果警報不存在或已經解決，靜默處理（這在自動解決中是正常的）
    if (process.env.NODE_ENV === "development") {
      logger.warn(
        `解決警報失敗（可能已解決） | 系統 ${systemId} | 參數 ${parameter}`,
        {
          error: error.message,
          systemId,
          parameter,
          module: "environmentMonitor",
        },
      );
    }
  }
}

/**
 * 檢查並解決環境位置閾值警報
 * 當數值超過閾值時創建警報，當數值恢復正常時自動解決對應的警報
 * @param {number} systemId - 地點系統 ID (location_systems.id)
 * @param {Object} sensorData - 感測器數據 { pm25, pm10, co2, temperature, humidity, noise, ... }
 * @param {Object} locationInfo - 位置資訊（包含名稱等）
 * @returns {Promise<void>}
 */
async function checkAndResolveThresholds(systemId, sensorData, locationInfo) {
  try {
    // 查詢所有啟用的閾值規則
    const rules = await alertRuleService.getThresholdRules("environment");

    if (!rules || rules.length === 0) {
      // 沒有規則，檢查是否有現有的閾值警報需要解決
      await resolveAllThresholdAlerts(systemId);
      return;
    }

    // 先查詢所有現有的 active 閾值警報（不限日期，用於解決跨天警報）
    // 使用 location_systems.id 作為 source_id
    // 注意：使用 findAllActiveAlerts 而非 getAlerts，因為需要解決跨天的警報
    const activeAlerts = await alertService.findAllActiveAlerts(
      alertService.ALERT_SOURCES.ENVIRONMENT,
      systemId,
      "threshold",
      null, // 不限定 dimension_key，先抓全部 active threshold
    );

    // 按參數分組規則（每個參數只匹配最嚴重的規則）
    const parameterRules = alertRuleService.groupRulesByParameter(rules);

    // 記錄每個參數的當前狀態
    const parameterExceededStatus = new Map(); // parameter -> { exceeded: boolean, matchedRule: rule|null }

    // 第一階段：檢查每個參數的規則，記錄狀態
    for (const [parameter, paramRules] of parameterRules) {
      const value = sensorData[parameter];

      // 如果數值不存在，跳過（設備可能離線或未配置）
      if (value === null || value === undefined) {
        continue;
      }

      // 按嚴重程度排序，匹配第一個（最嚴重）
      let matchedRule = null;
      let thresholdExceeded = false;

      for (const rule of paramRules) {
        const config = rule.condition_config;
        if (alertRuleService.evaluateThreshold(config, value)) {
          // 匹配到規則
          thresholdExceeded = true;
          matchedRule = rule;
          break; // 只使用最嚴重的規則
        }
      }

      // 記錄參數狀態
      parameterExceededStatus.set(parameter, {
        exceeded: thresholdExceeded,
        matchedRule: matchedRule,
        value: value,
      });

      // 調試日誌：只在超過閾值或啟用詳細日誌時輸出
      if (thresholdExceeded || process.env.ENABLE_DETAILED_LOGS === "true") {
        const status = thresholdExceeded
          ? `超過閾值 (${matchedRule.severity})`
          : "正常";
        logger.debug(
          `位置 ${locationInfo?.name || systemId} | 參數 ${parameter} | 數值 ${value} | ${status}`,
          {
            locationName: locationInfo?.name,
            systemId,
            parameter,
            value,
            status,
            module: "environmentMonitor",
          },
        );
      }
    }

    // 第二階段：處理警報創建/更新/解決
    // 優化：直接調用 createAlert，讓它處理創建/更新邏輯（避免重複匹配邏輯）
    for (const [parameter, status] of parameterExceededStatus) {
      const { exceeded, matchedRule, value } = status;

      if (exceeded) {
        // 數值超過閾值
        const message = await alertRuleService.renderRuleMessage(matchedRule, {
          source_id: systemId,
          current_value: value,
          value,
        });

        await alertService.createAlert({
          source: alertService.ALERT_SOURCES.ENVIRONMENT,
          source_id: systemId,
          alert_type: "threshold",
          dimension_key: `threshold:${String(parameter).toLowerCase()}`,
          rule_id: matchedRule.id,
          severity: matchedRule.severity,
          message,
        });
      } else {
        // 數值未超過閾值，如果有對應的 active 警報，則解決它
        // 使用 findAllActiveAlerts 並傳遞參數，精確匹配需要解決的警報
        const parameterAlerts = await alertService.findAllActiveAlerts(
          alertService.ALERT_SOURCES.ENVIRONMENT,
          systemId,
          "threshold",
          `threshold:${String(parameter).toLowerCase()}`,
        );

        if (parameterAlerts.length > 0) {
          await resolveThresholdAlert(
            systemId,
            parameter,
            value,
            "數值已恢復正常",
          );
        }
      }
    }

    // 第三階段：處理其他參數的警報（如果該參數在第一階段沒有被處理，但數值存在且正常）
    // 對於每個未處理的參數，檢查是否有對應的警報需要解決
    for (const parameter of Array.from(parameterRules.keys())) {
      // 如果這個參數已經在第二階段處理過了，跳過
      if (parameterExceededStatus.has(parameter)) {
        continue;
      }

      const value = sensorData[parameter];
      // 如果數值不存在，跳過（設備可能離線或未配置）
      if (value === null || value === undefined) {
        continue;
      }

      // 檢查是否有該參數的警報（使用參數顯示名稱精確匹配）
      const parameterAlerts = await alertService.findAllActiveAlerts(
        alertService.ALERT_SOURCES.ENVIRONMENT,
        systemId,
        "threshold",
        `threshold:${String(parameter).toLowerCase()}`,
      );

      // 如果沒有該參數的警報，跳過
      if (parameterAlerts.length === 0) {
        continue;
      }

      // 檢查該參數的數值是否超過閾值
      const paramRules = parameterRules.get(parameter);
      if (paramRules) {
        let stillExceeded = false;
        for (const rule of paramRules) {
          if (
            alertRuleService.evaluateThreshold(rule.condition_config, value)
          ) {
            stillExceeded = true;
            break;
          }
        }

        // 如果數值不再超過閾值，解決警報
        if (!stillExceeded) {
          await resolveThresholdAlert(
            systemId,
            parameter,
            value,
            "數值已恢復正常",
          );
        }
      }
    }
  } catch (error) {
    logger.error(`檢查並解決閾值失敗 (systemId: ${systemId})`, {
      error,
      systemId,
      module: "environmentMonitor",
    });
  }
}

/**
 * 解決位置的所有閾值警報（當沒有規則時）
 * @param {number} systemId - 地點系統 ID (location_systems.id)
 * @returns {Promise<void>}
 */
async function resolveAllThresholdAlerts(systemId) {
  try {
    // 使用 findAllActiveAlerts 獲取所有 active 閾值警報（不限日期）
    const activeAlerts = await alertService.findAllActiveAlerts(
      alertService.ALERT_SOURCES.ENVIRONMENT,
      systemId,
      "threshold",
      null, // 不限定參數，獲取所有閾值警報
    );

    // 如果有多個警報，updateAlertStatus 會一次性解決所有匹配的警報
    // 所以不需要循環調用，直接調用一次即可
    if (activeAlerts.length > 0) {
      await alertService.updateAlertStatus(
        systemId,
        alertService.ALERT_SOURCES.ENVIRONMENT,
        "threshold",
        alertService.ALERT_STATUS.RESOLVED,
        null,
      );

      if (process.env.ENABLE_DETAILED_LOGS === "true") {
        logger.debug(
          `解決所有閾值警報 | 系統 ${systemId} | 共 ${activeAlerts.length} 個警報`,
          {
            systemId,
            alertCount: activeAlerts.length,
            module: "environmentMonitor",
          },
        );
      }
    }
  } catch (error) {
    // 如果警報不存在或已經解決，靜默處理
    if (process.env.NODE_ENV === "development") {
      logger.warn(`解決所有閾值警報失敗（可能已解決） | 系統 ${systemId}`, {
        error: error.message,
        systemId,
        module: "environmentMonitor",
      });
    }
  }
}

module.exports = {
  checkEnvironmentLocations,
  checkAndResolveThresholds,
};
