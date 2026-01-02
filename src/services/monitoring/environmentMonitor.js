/**
 * 環境系統監控任務
 * 定期檢查所有環境位置的感測器設備狀態
 */

const db = require("../../database/db");
const modbusClient = require("../devices/modbusClient");
const systemAlert = require("../alerts/systemAlertHelper");
const alertRuleService = require("../alerts/alertRuleService");
const alertService = require("../alerts/alertService");

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

        // 讀取成功，清除錯誤狀態
        await systemAlert.clearError("environment", location.id);

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
        // 讀取失敗，記錄錯誤（不檢查閾值）
        const errorMessage = error.message || "無法讀取感測器資料";
        await systemAlert.recordError("environment", location.id, errorMessage);

        return {
          locationId: location.id,
          success: false,
          reason: errorMessage,
        };
      }
    });

    const results = await Promise.allSettled(checkPromises);

    results.forEach((result) => {
      if (result.status === "fulfilled") {
        if (result.value.success) {
          successCount++;
        } else {
          failCount++;
        }
      } else {
        failCount++;
      }
    });

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

    // 按參數分組規則（每個參數只匹配最嚴重的規則）
    const parameterRules = alertRuleService.groupRulesByParameter(rules);

    // 記錄哪些參數觸發了警報
    const triggeredParameters = new Set();

    // 檢查每個參數的規則
    for (const [parameter, paramRules] of parameterRules) {
      const value = sensorData[parameter];

      // 如果數值不存在，跳過（設備可能離線或未配置）
      if (value === null || value === undefined) {
        continue;
      }

      // 按嚴重程度排序，匹配第一個（最嚴重）
      let thresholdExceeded = false;
      for (const rule of paramRules) {
        const config = rule.condition_config;
        if (alertRuleService.evaluateThreshold(config, value)) {
          // 匹配到規則，創建警報
          thresholdExceeded = true;
          triggeredParameters.add(parameter);

          const message = alertRuleService.formatMessage(
            rule.message_template,
            {
              source_name: locationInfo?.name || `位置 ${locationId}`,
              parameter: alertRuleService.getParameterDisplayName(parameter),
              value: value,
              threshold: config.value,
              unit: config.unit || "",
            }
          );

          await systemAlert.createAlert(
            "environment",
            locationId,
            "threshold",
            rule.severity,
            message
          );

          // 只創建一個警報（最嚴重的），跳出循環
          break;
        }
      }

      // 如果數值未超過閾值，檢查是否有對應的 active 警報需要解決
      if (!thresholdExceeded) {
        await resolveThresholdAlert(locationId, parameter);
      }
    }

    // 解決其他參數的閾值警報（如果該參數沒有規則但數值存在且正常）
    // 查詢所有現有的 active 閾值警報
    const activeAlerts = await alertService.getAlerts({
      source: alertService.ALERT_SOURCES.ENVIRONMENT,
      source_id: locationId,
      alert_type: "threshold",
      status: alertService.ALERT_STATUS.ACTIVE,
    });

    // 對於每個 active 警報，檢查對應的參數是否在觸發列表中
    // 如果不在，且該參數的數值存在且正常，則解決警報
    for (const alert of activeAlerts.alerts || []) {
      const message = alert.message || "";

      // 檢查所有已知的參數，看哪個參數的顯示名稱在警報訊息中
      for (const parameter of Array.from(parameterRules.keys())) {
        // 如果這個參數已經觸發了警報，跳過
        if (triggeredParameters.has(parameter)) {
          continue;
        }

        // 檢查數值是否存在且正常
        const value = sensorData[parameter];
        if (value === null || value === undefined) {
          continue;
        }

        // 檢查警報訊息是否包含該參數的顯示名稱
        const parameterDisplayName =
          alertRuleService.getParameterDisplayName(parameter);
        if (
          message.includes(parameterDisplayName) ||
          message.toLowerCase().includes(parameter.toLowerCase())
        ) {
          // 檢查該參數的數值是否超過任何規則的閾值
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
                  `[environmentMonitor] 自動解決位置 ${locationId} 的 ${parameter} 閾值警報`
                );
              }
              break; // 解決了一個警報，跳出參數循環
            }
          }
        }
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
 * 解決特定參數的閾值警報（內部輔助函數）
 * @param {number} locationId - 環境位置 ID
 * @param {string} parameter - 參數名稱
 * @returns {Promise<void>}
 */
async function resolveThresholdAlert(locationId, parameter) {
  try {
    const alerts = await alertService.getAlerts({
      source: alertService.ALERT_SOURCES.ENVIRONMENT,
      source_id: locationId,
      alert_type: "threshold",
      status: alertService.ALERT_STATUS.ACTIVE,
    });

    const parameterDisplayName =
      alertRuleService.getParameterDisplayName(parameter);

    for (const alert of alerts.alerts || []) {
      const message = alert.message || "";
      if (
        message.toLowerCase().includes(parameter.toLowerCase()) ||
        message.includes(parameterDisplayName)
      ) {
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
            `[environmentMonitor] 自動解決位置 ${locationId} 的 ${parameter} 閾值警報`
          );
        }
        break; // 只解決第一個匹配的警報
      }
    }
  } catch (error) {
    console.error(
      `[environmentMonitor] 解決閾值警報失敗 (locationId: ${locationId}, parameter: ${parameter}):`,
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
