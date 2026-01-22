/**
 * 環境系統監控任務
 * 定期檢查所有環境位置的感測器設備狀態
 */

const db = require("../../database/db");
const modbusClient = require("../devices/modbusClient");
const systemAlert = require("../alerts/systemAlertHelper");
const websocketService = require("../websocket/websocketService");
const alertRuleService = require("../alerts/alertRuleService");
const alertService = require("../alerts/alertService");
const deviceDataLogger = require("../devices/deviceDataLogger");
const logger = require("../../utils/logger");

// 追蹤上次的設備狀態，只在狀態改變時才推送 WebSocket 事件（優化：減少不必要的推送）
const lastDeviceStatus = new Map(); // key: `${system}:${sourceId}`, value: 'online' | 'offline'

/**
 * 檢查環境位置的感測器狀態
 */
async function checkEnvironmentLocations() {
  try {
    // 取得所有有環境監測系統的地點（使用新架構 location_systems）
    const locations = await db.query(`
			SELECT 
				l.id as location_id,
				l.name as location_name,
				l.zone_id,
				z.name as zone_name,
				ls.id as system_id,
				ls.system_config->>'device_id' as device_id,
				d.config as device_config,
				dt.code as device_type_code
			FROM locations l
			INNER JOIN zones z ON l.zone_id = z.id
			INNER JOIN location_systems ls ON l.id = ls.location_id
			INNER JOIN devices d ON (ls.system_config->>'device_id')::integer = d.id
			INNER JOIN device_types dt ON d.type_id = dt.id
			WHERE ls.system_type = 'environment'
				AND d.status = 'active'
				AND dt.code = 'sensor'
				AND d.config->>'protocol' = 'modbus'
		`);

    if (locations.length === 0) {
      return;
    }

    let successCount = 0;
    let failCount = 0;

    // 並行檢查所有位置（提高效率）
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
        await modbusClient.readHoldingRegisters(0, 1, deviceConfig);

        // 讀取成功，清除錯誤狀態（使用 location_systems.id，批次模式：跳過即時推送）
        await systemAlert.clearError("environment", location.system_id, { skipWebSocket: true });

        // 記錄設備數值（如果設備配置了 logging）
        const deviceId = location.device_id ? parseInt(location.device_id) : null;
        if (deviceId) {
          try {
            const loggingConfig = await deviceDataLogger.getDeviceLoggingConfig(deviceId);
            
            if (loggingConfig.enabled && loggingConfig.values && loggingConfig.values.length > 0) {
              // 找出所有需要讀取的 holding 寄存器
              const holdingRegisters = loggingConfig.values.filter(
                v => v.enabled && v.register_type === "holding"
              );

              if (holdingRegisters.length > 0) {
                // 計算需要讀取的寄存器範圍
                let minAddress = holdingRegisters[0].address;
                let maxAddress = holdingRegisters[0].address + (holdingRegisters[0].length || 1);
                
                for (const valueConfig of holdingRegisters) {
                  const startAddr = valueConfig.address;
                  const endAddr = valueConfig.address + (valueConfig.length || 1);
                  minAddress = Math.min(minAddress, startAddr);
                  maxAddress = Math.max(maxAddress, endAddr);
                }

                const readLength = maxAddress - minAddress;

                // 讀取所有需要的寄存器
                if (readLength > 0) {
                  const modbusData = await modbusClient.readHoldingRegisters(
                    minAddress,
                    readLength,
                    deviceConfig
                  );

                  // 轉換為實際數值（需要調整地址偏移，因為我們從 minAddress 開始讀取）
                  const deviceValues = {};
                  
                  for (const valueConfig of holdingRegisters) {
                    // 計算在讀取資料中的相對地址
                    const relativeAddress = valueConfig.address - minAddress;
                    const rawValue = Array.isArray(modbusData) && relativeAddress >= 0 && relativeAddress < modbusData.length
                      ? (valueConfig.length === 1 ? modbusData[relativeAddress] : modbusData.slice(relativeAddress, relativeAddress + (valueConfig.length || 1)))
                      : null;

                    if (rawValue !== null && rawValue !== undefined) {
                      // 套用轉換
                      const convertedValue = deviceDataLogger.applyConversion(rawValue, valueConfig.conversion);
                      
                      deviceValues[valueConfig.name] = {
                        value: convertedValue,
                        unit: valueConfig.conversion?.unit || null,
                      };
                    }
                  }

                  // 記錄到 device_data_logs（非阻塞，傳入配置避免重複查詢）
                  if (Object.keys(deviceValues).length > 0) {
                    deviceDataLogger.logDeviceValues(deviceId, deviceValues, loggingConfig).catch((error) => {
                      logger.error(`記錄設備數值失敗 (deviceId: ${deviceId})`, {
                        error: error.message,
                        deviceId,
                        module: "environmentMonitor",
                      });
                    });
                  }
                }
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
        // 從 device_data_logs 獲取最新數據進行閾值檢查（聚合同一時間點的所有數值）
        try {
          const deviceId = location.device_id ? parseInt(location.device_id) : null;
          if (!deviceId) {
            return { systemId: location.system_id, locationId: location.location_id, success: true };
          }

          // 獲取最新的設備數值記錄（使用時間窗口聚合，確保批次寫入的記錄能被正確聚合）
          const latestReading = await db.query(
            `SELECT 
               date_trunc('second', recorded_at) as timestamp,
               jsonb_object_agg(
                 value->>'name',
                 (value->>'value')::numeric
               ) as data
             FROM device_data_logs
             WHERE device_id = $1
               AND recorded_at >= NOW() - INTERVAL '1 minute'
             GROUP BY date_trunc('second', recorded_at)
             ORDER BY timestamp DESC 
             LIMIT 1`,
            [deviceId]
          );

          if (latestReading && latestReading.length > 0 && latestReading[0].data) {
            const sensorData = latestReading[0].data;

            // 調試日誌：只在需要時輸出（可通過環境變數控制）
            // 設置 ENABLE_DETAILED_LOGS=true 來啟用詳細日誌
            if (process.env.ENABLE_DETAILED_LOGS === "true") {
              logger.debug(`位置 ${location.location_id} (${location.location_name}) 感測器數據`, {
                locationId: location.location_id,
                locationName: location.location_name,
                sensorData,
                module: "environmentMonitor",
              });
            }

            // 檢查閾值並自動解決恢復正常的警報（使用 location_systems.id）
            await checkAndResolveThresholds(location.system_id, sensorData, {
              name: location.location_name,
              zone_name: location.zone_name,
            });
          }
        } catch (thresholdError) {
          // 閾值檢查失敗不影響連線檢查結果
          logger.error(`檢查位置 ${location.location_id} 閾值失敗`, {
            error: thresholdError.message,
            locationId: location.location_id,
            module: "environmentMonitor",
          });
        }

        return { systemId: location.system_id, locationId: location.location_id, success: true };
      } catch (error) {
        // 讀取失敗，記錄錯誤（不檢查閾值）（批次模式：跳過即時推送）
        // 使用 location_systems.id 作為 source_id
        const errorMessage = error.message || "無法讀取感測器資料";
        await systemAlert.recordError("environment", location.system_id, errorMessage, { skipWebSocket: true });

        return {
          systemId: location.system_id,
          locationId: location.location_id,
          success: false,
          reason: errorMessage,
        };
      }
    });

    const results = await Promise.allSettled(checkPromises);

    // 收集狀態更新，用於批次推送（只收集狀態改變的設備）
    const statusUpdates = [];

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        const systemId = result.value.systemId;
        const locationId = result.value.locationId;
        const key = `environment:${systemId}`;
        const currentStatus = result.value.success ? "online" : "offline";
        const lastStatus = lastDeviceStatus.get(key);

        // 從原始 locations 陣列中獲取 device_id
        const location = locations[index];
        const deviceId = location?.device_id ? parseInt(location.device_id) : null;

        // 只在狀態改變時才添加到更新列表
        if (lastStatus !== currentStatus) {
          lastDeviceStatus.set(key, currentStatus);
          
          if (result.value.success) {
            successCount++;
            statusUpdates.push({
              system: "environment",
              sourceId: systemId,
              deviceId: deviceId,
              status: "online",
            });
          } else {
            failCount++;
            statusUpdates.push({
              system: "environment",
              sourceId: systemId,
              deviceId: deviceId,
              status: "offline",
            });
          }
        } else {
          // 狀態沒有改變，只更新計數（不推送 WebSocket）
          if (result.value.success) {
            successCount++;
          } else {
            failCount++;
          }
        }
      } else {
        // Promise 被 reject，記錄錯誤並標記為離線
        failCount++;
        const location = locations[index];
        if (location) {
          const key = `environment:${location.system_id}`;
          const lastStatus = lastDeviceStatus.get(key);
          
          // 只在狀態改變時才推送
          if (lastStatus !== "offline") {
            lastDeviceStatus.set(key, "offline");
            statusUpdates.push({
              system: "environment",
              sourceId: location.system_id,
              deviceId: location.device_id ? parseInt(location.device_id) : null,
              status: "offline",
            });
          }
        }
          logger.error("檢查位置失敗 (Promise rejected)", {
            error: result.reason?.message || result.reason,
            locationId: location?.location_id,
            module: "environmentMonitor",
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
async function resolveThresholdAlert(systemId, parameter, value, reason = "數值已恢復正常") {
  try {
    await alertService.updateAlertStatus(
      systemId,
      alertService.ALERT_SOURCES.ENVIRONMENT,
      "threshold",
      alertService.ALERT_STATUS.RESOLVED,
      null,
      reason
    );

    // 只在啟用詳細日誌時輸出
    if (process.env.ENABLE_DETAILED_LOGS === "true") {
      logger.debug(`解決警報 | 系統 ${systemId} | 參數 ${parameter} | 數值: ${value} (${reason})`, {
        systemId,
        parameter,
        value,
        reason,
        module: "environmentMonitor",
      });
    }
  } catch (error) {
    // 如果警報不存在或已經解決，靜默處理（這在自動解決中是正常的）
    if (process.env.NODE_ENV === "development") {
      logger.warn(`解決警報失敗（可能已解決） | 系統 ${systemId} | 參數 ${parameter}`, {
        error: error.message,
        systemId,
        parameter,
        module: "environmentMonitor",
      });
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
      null // 參數匹配將在後續處理中進行
    );

    // 按參數分組規則（每個參數只匹配最嚴重的規則）
    const parameterRules = alertRuleService.groupRulesByParameter(rules);

    // 記錄哪些參數觸發了警報，以及每個參數的當前狀態
    const triggeredParameters = new Set();
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

      if (thresholdExceeded) {
        triggeredParameters.add(parameter);
      }

      // 調試日誌：只在超過閾值或啟用詳細日誌時輸出
      if (thresholdExceeded || process.env.ENABLE_DETAILED_LOGS === "true") {
        const status = thresholdExceeded
          ? `超過閾值 (${matchedRule.severity})`
          : "正常";
        logger.debug(`位置 ${locationInfo?.name || systemId} | 參數 ${parameter} | 數值 ${value} | ${status}`, {
          locationName: locationInfo?.name,
          systemId,
          parameter,
          value,
          status,
          module: "environmentMonitor",
        });
      }
    }

    // 第二階段：處理警報創建/更新/解決
    // 優化：直接調用 createAlert，讓它處理創建/更新邏輯（避免重複匹配邏輯）
    for (const [parameter, status] of parameterExceededStatus) {
      const { exceeded, matchedRule, value } = status;

      if (exceeded) {
        // 數值超過閾值
        const parameterDisplayName =
          alertRuleService.getParameterDisplayName(parameter);
        const message = alertRuleService.formatMessage(
          matchedRule.message_template,
          {
            source_name: locationInfo?.name || `位置 ${systemId}`,
            parameter: parameterDisplayName,
            value: value,
            threshold: matchedRule.condition_config.value,
            unit: matchedRule.condition_config.unit || "",
          }
        );

        // 直接調用 createAlert，它會自動處理：
        // 1. 檢查忽視狀態
        // 2. 查找現有警報（使用參數匹配）
        // 3. 更新現有警報或創建新警報
        // 4. 輸出適當的日誌
        // 使用 location_systems.id 作為 source_id
          await systemAlert.createAlert(
            "environment",
            systemId,
            "threshold",
            matchedRule.severity,
            message
          );
      } else {
        // 數值未超過閾值，如果有對應的 active 警報，則解決它
        // 使用 findAllActiveAlerts 並傳遞參數，精確匹配需要解決的警報
        const parameterDisplayName =
          alertRuleService.getParameterDisplayName(parameter);
        const parameterAlerts = await alertService.findAllActiveAlerts(
          alertService.ALERT_SOURCES.ENVIRONMENT,
          systemId,
          "threshold",
          parameterDisplayName // 傳遞參數名稱，精確匹配
        );
        
        if (parameterAlerts.length > 0) {
          await resolveThresholdAlert(
            systemId,
            parameter,
            value,
            "數值已恢復正常"
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
      const parameterDisplayName =
        alertRuleService.getParameterDisplayName(parameter);
      const parameterAlerts = await alertService.findAllActiveAlerts(
        alertService.ALERT_SOURCES.ENVIRONMENT,
        systemId,
        "threshold",
        parameterDisplayName
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
            alertRuleService.evaluateThreshold(
              rule.condition_config,
              value
            )
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
            "數值已恢復正常"
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
      null // 不限定參數，獲取所有閾值警報
    );

    // 如果有多個警報，updateAlertStatus 會一次性解決所有匹配的警報
    // 所以不需要循環調用，直接調用一次即可
    if (activeAlerts.length > 0) {
      await alertService.updateAlertStatus(
        systemId,
        alertService.ALERT_SOURCES.ENVIRONMENT,
        "threshold",
        alertService.ALERT_STATUS.RESOLVED,
        null, // 系統自動解決
        "規則已移除，自動解決警報"
      );

      if (process.env.ENABLE_DETAILED_LOGS === "true") {
        logger.debug(`解決所有閾值警報 | 系統 ${systemId} | 共 ${activeAlerts.length} 個警報`, {
          systemId,
          alertCount: activeAlerts.length,
          module: "environmentMonitor",
        });
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
