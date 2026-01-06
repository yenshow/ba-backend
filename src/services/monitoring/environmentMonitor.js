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

// 追蹤上次的設備狀態，只在狀態改變時才推送 WebSocket 事件（優化：減少不必要的推送）
const lastDeviceStatus = new Map(); // key: `${system}:${sourceId}`, value: 'online' | 'offline'

/**
 * 檢查環境位置的感測器狀態
 */
async function checkEnvironmentLocations() {
  try {
    // 取得所有有設備的環境位置
    const locations = await db.query(`
			SELECT 
				el.id, 
				el.name, 
				el.device_id, 
				d.config, 
				dt.code as device_type_code,
				ef.name as floor_name
			FROM environment_locations el
			INNER JOIN devices d ON el.device_id = d.id
			INNER JOIN device_types dt ON d.type_id = dt.id
			INNER JOIN environment_floors ef ON el.floor_id = ef.id
			WHERE d.status = 'active'
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
        const config =
          typeof location.config === "string"
            ? JSON.parse(location.config)
            : location.config;

        if (!config.host || !config.port) {
          return {
            locationId: location.id,
            success: false,
            reason: "配置不完整",
          };
        }

        const deviceConfig = {
          host: config.host,
          port: config.port,
          unitId: config.unitId || 1,
        };

        // 嘗試讀取第一個保持寄存器（地址 0）來檢查設備狀態
        // 這是一個輕量級的檢查，不會讀取大量數據
        await modbusClient.readHoldingRegisters(0, 1, deviceConfig);

        // 讀取成功，清除錯誤狀態（批次模式：跳過即時推送）
        await systemAlert.clearError("environment", location.id, { skipWebSocket: true });

        // 讀取成功後，檢查閾值（僅在設備連接正常時）
        // 從最新的感測器讀數中獲取數據進行閾值檢查
        try {
          const latestReading = await db.query(
            `SELECT data, timestamp 
             FROM sensor_readings 
             WHERE location_id = ? 
             ORDER BY timestamp DESC 
             LIMIT 1`,
            [location.id]
          );

          if (latestReading && latestReading.length > 0) {
            const sensorData =
              typeof latestReading[0].data === "string"
                ? JSON.parse(latestReading[0].data)
                : latestReading[0].data;

            // 檢查閾值並自動解決恢復正常的警報
            await checkAndResolveThresholds(location.id, sensorData, {
              name: location.name,
              floor_name: location.floor_name,
            });
          }
        } catch (thresholdError) {
          // 閾值檢查失敗不影響連線檢查結果
          console.error(
            `[environmentMonitor] 檢查位置 ${location.id} 閾值失敗:`,
            thresholdError.message
          );
        }

        return { locationId: location.id, success: true };
      } catch (error) {
        // 讀取失敗，記錄錯誤（不檢查閾值）（批次模式：跳過即時推送）
        const errorMessage = error.message || "無法讀取感測器資料";
        await systemAlert.recordError("environment", location.id, errorMessage, { skipWebSocket: true });

        return {
          locationId: location.id,
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
        const locationId = result.value.locationId;
        const key = `environment:${locationId}`;
        const currentStatus = result.value.success ? "online" : "offline";
        const lastStatus = lastDeviceStatus.get(key);

        // 只在狀態改變時才添加到更新列表
        if (lastStatus !== currentStatus) {
          lastDeviceStatus.set(key, currentStatus);
          
          if (result.value.success) {
            successCount++;
            statusUpdates.push({
              system: "environment",
              sourceId: locationId,
              status: "online",
            });
          } else {
            failCount++;
            statusUpdates.push({
              system: "environment",
              sourceId: locationId,
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
          const key = `environment:${location.id}`;
          const lastStatus = lastDeviceStatus.get(key);
          
          // 只在狀態改變時才推送
          if (lastStatus !== "offline") {
            lastDeviceStatus.set(key, "offline");
            statusUpdates.push({
              system: "environment",
              sourceId: location.id,
              status: "offline",
            });
          }
        }
        console.error(
          `[environmentMonitor] 檢查位置失敗 (Promise rejected):`,
          result.reason
        );
      }
    });

    // 批次推送設備狀態更新（只推送狀態改變的設備）
    if (statusUpdates.length > 0) {
      websocketService.emitBatchDeviceStatus(statusUpdates);
    }

    if (successCount > 0 || failCount > 0) {
      console.log(
        `[environmentMonitor] 檢查完成: 成功 ${successCount} 個，失敗 ${failCount} 個`
      );
    }
  } catch (error) {
    console.error("[environmentMonitor] 檢查環境位置失敗:", error);
    throw error;
  }
}

/**
 * 根據參數名稱查找警報（輔助函數）
 * @param {Array} alerts - 警報列表
 * @param {string} parameter - 參數名稱（如 "pm25"）
 * @param {string} parameterDisplayName - 參數顯示名稱（如 "PM2.5"）
 * @returns {Object|null} 匹配的警報
 */
function findAlertByParameter(alerts, parameter, parameterDisplayName) {
  for (const alert of alerts) {
    const message = alert.message || "";
    // 檢查訊息中是否包含參數名稱或顯示名稱
    if (
      message.includes(parameterDisplayName) ||
      message.toLowerCase().includes(parameter.toLowerCase())
    ) {
      return alert;
    }
  }
  return null;
}

/**
 * 檢查並解決環境位置閾值警報
 * 當數值超過閾值時創建警報，當數值恢復正常時自動解決對應的警報
 * @param {number} locationId - 環境位置 ID
 * @param {Object} sensorData - 感測器數據 { pm25, pm10, co2, temperature, humidity, noise, ... }
 * @param {Object} locationInfo - 位置資訊（包含名稱等）
 * @returns {Promise<void>}
 */
async function checkAndResolveThresholds(locationId, sensorData, locationInfo) {
  try {
    // 查詢所有啟用的閾值規則
    const rules = await alertRuleService.getThresholdRules("environment");

    if (!rules || rules.length === 0) {
      // 沒有規則，檢查是否有現有的閾值警報需要解決
      await resolveAllThresholdAlerts(locationId);
      return;
    }

    // 先查詢所有現有的 active 閾值警報（優化：一次性查詢）
    const activeAlertsResult = await alertService.getAlerts({
      source: alertService.ALERT_SOURCES.ENVIRONMENT,
      source_id: locationId,
      alert_type: "threshold",
      status: alertService.ALERT_STATUS.ACTIVE,
    });

    const activeAlerts = activeAlertsResult.alerts || [];

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

      // 調試日誌：記錄閾值檢查結果
      if (process.env.NODE_ENV === "development") {
        const status = thresholdExceeded
          ? `超過閾值 (${matchedRule.severity})`
          : "正常";
        console.log(
          `[environmentMonitor] 位置 ${locationId} | 參數 ${parameter} | 數值 ${value} | ${status}`
        );
      }
    }

    // 第二階段：處理警報創建/更新/解決
    for (const [parameter, status] of parameterExceededStatus) {
      const { exceeded, matchedRule, value } = status;

      // 查找是否已存在該參數的 active 警報
      const parameterDisplayName =
        alertRuleService.getParameterDisplayName(parameter);
      const existingAlert = findAlertByParameter(
        activeAlerts,
        parameter,
        parameterDisplayName
      );

      if (exceeded) {
        // 數值超過閾值
        const message = alertRuleService.formatMessage(
          matchedRule.message_template,
          {
            source_name: locationInfo?.name || `位置 ${locationId}`,
            parameter: parameterDisplayName,
            value: value,
            threshold: matchedRule.condition_config.value,
            unit: matchedRule.condition_config.unit || "",
          }
        );

        if (existingAlert) {
          // 已存在警報，檢查嚴重程度是否改變
          if (existingAlert.severity !== matchedRule.severity) {
            // 嚴重程度改變，更新警報（升級）
            await systemAlert.createAlert(
              "environment",
              locationId,
              "threshold",
              matchedRule.severity,
              message
            );

            if (process.env.NODE_ENV === "development") {
              console.log(
                `[environmentMonitor] 更新警報 | 位置 ${locationId} | 參數 ${parameter} | ` +
                  `嚴重程度: ${existingAlert.severity} -> ${matchedRule.severity} | 數值: ${value}`
              );
            }
          } else {
            // 嚴重程度相同，不需要更新（避免不必要的 updated_at 更新）
            if (process.env.NODE_ENV === "development") {
              console.log(
                `[environmentMonitor] 警報已存在且嚴重程度未改變 | 位置 ${locationId} | ` +
                  `參數 ${parameter} | 嚴重程度: ${matchedRule.severity} | 數值: ${value}`
              );
            }
          }
        } else {
          // 不存在警報，創建新警報
          await systemAlert.createAlert(
            "environment",
            locationId,
            "threshold",
            matchedRule.severity,
            message
          );

          if (process.env.NODE_ENV === "development") {
            console.log(
              `[environmentMonitor] 創建警報 | 位置 ${locationId} | 參數 ${parameter} | ` +
                `嚴重程度: ${matchedRule.severity} | 數值: ${value} | 閾值: ${matchedRule.condition_config.value}`
            );
          }
        }
      } else {
        // 數值未超過閾值，如果有對應的 active 警報，則解決它
        if (existingAlert) {
          await alertService.updateAlertStatus(
            locationId,
            alertService.ALERT_SOURCES.ENVIRONMENT,
            "threshold",
            alertService.ALERT_STATUS.RESOLVED,
            null,
            "數值已恢復正常"
          );

          if (process.env.NODE_ENV === "development") {
            console.log(
              `[environmentMonitor] 解決警報 | 位置 ${locationId} | 參數 ${parameter} | ` +
                `數值: ${value} (已低於閾值)`
            );
          }
        }
      }
    }

    // 第三階段：處理其他參數的警報（如果該參數在第一階段沒有被處理，但數值存在且正常）
    // 對於每個 active 警報，檢查對應的參數是否仍然超過閾值
    for (const alert of activeAlerts) {
      const message = alert.message || "";

      // 檢查所有已知的參數，看哪個參數的顯示名稱在警報訊息中
      let matched = false;
      for (const parameter of Array.from(parameterRules.keys())) {
        // 如果這個參數已經在第二階段處理過了，跳過
        if (triggeredParameters.has(parameter) || parameterExceededStatus.has(parameter)) {
          continue;
        }

        // 檢查警報訊息是否包含該參數的顯示名稱
        const parameterDisplayName =
          alertRuleService.getParameterDisplayName(parameter);
        if (
          message.includes(parameterDisplayName) ||
          message.toLowerCase().includes(parameter.toLowerCase())
        ) {
          matched = true;

          // 檢查該參數的數值是否存在且是否超過閾值
          const value = sensorData[parameter];
          if (value === null || value === undefined) {
            break; // 數值不存在，跳出
          }

          // 檢查是否超過閾值
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
              await alertService.updateAlertStatus(
                locationId,
                alertService.ALERT_SOURCES.ENVIRONMENT,
                "threshold",
                alertService.ALERT_STATUS.RESOLVED,
                null,
                "數值已恢復正常"
              );

              if (process.env.NODE_ENV === "development") {
                console.log(
                  `[environmentMonitor] 解決警報 | 位置 ${locationId} | 參數 ${parameter} | ` +
                    `數值: ${value} (已恢復正常)`
                );
              }
            }
          }
          break; // 找到匹配的參數後跳出循環
        }
      }

      // 如果沒有匹配到任何參數，記錄警告（可能有格式不正確的警報）
      if (!matched && process.env.NODE_ENV === "development") {
        console.warn(
          `[environmentMonitor] 無法匹配警報訊息中的參數 | 位置 ${locationId} | ` +
            `警報 ID: ${alert.id} | 訊息: ${message}`
        );
      }
    }
  } catch (error) {
    console.error(
      `[environmentMonitor] 檢查並解決閾值失敗 (locationId: ${locationId}):`,
      error
    );
  }
}

/**
 * 解決位置的所有閾值警報（當沒有規則時）
 * @param {number} locationId - 環境位置 ID
 * @returns {Promise<void>}
 */
async function resolveAllThresholdAlerts(locationId) {
  try {
    const alerts = await alertService.getAlerts({
      source: alertService.ALERT_SOURCES.ENVIRONMENT,
      source_id: locationId,
      alert_type: "threshold",
      status: alertService.ALERT_STATUS.ACTIVE,
    });

    for (const alert of alerts.alerts || []) {
      await alertService.updateAlertStatus(
        locationId,
        alertService.ALERT_SOURCES.ENVIRONMENT,
        "threshold",
        alertService.ALERT_STATUS.RESOLVED,
        null, // 系統自動解決
        "規則已移除，自動解決警報"
      );
    }
  } catch (error) {
    console.error(
      `[environmentMonitor] 解決所有閾值警報失敗 (locationId: ${locationId}):`,
      error
    );
  }
}

module.exports = {
  checkEnvironmentLocations,
  checkAndResolveThresholds,
};
