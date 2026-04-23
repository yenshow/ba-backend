/**
 * 照明系統監控任務
 * 定期檢查所有照明區域的設備狀態
 */

const db = require("../../database/db");
const modbusBatchService = require("../devices/modbusBatchService");
const systemAlert = require("../alerts/systemAlertHelper");
const websocketService = require("../websocket/websocketService");
const logger = require("../../utils/logger");

// 追蹤上次的設備狀態，只在狀態改變時才推送 WebSocket 事件（優化：減少不必要的推送）
const lastDeviceStatus = new Map(); // key: `${system}:${sourceId}`, value: 'online' | 'offline'

/**
 * 檢查照明區域的設備狀態
 */
async function checkLightingAreas() {
  try {
    // 取得所有照明地點
    const areas = await db.query(`
			SELECT 
				l.id as location_id,
				l.name as location_name,
				l.zone_id,
				z.name as zone_name,
				ls.id as system_id,
				COALESCE(ls.system_config->>'device_id', ls.system_config->>'deviceId') as device_id,
				ls.system_config->'modbus_config' as modbus_config,
				d.config as device_config,
				d.type_code as device_type_code
			FROM locations l
			INNER JOIN zones z ON l.zone_id = z.id
			INNER JOIN location_systems ls ON l.id = ls.location_id
			INNER JOIN devices d ON COALESCE((ls.system_config->>'device_id')::integer, (ls.system_config->>'deviceId')::integer) = d.id
			WHERE ls.system_type = 'lighting'
				AND (ls.system_config->>'device_id' IS NOT NULL OR ls.system_config->>'deviceId' IS NOT NULL)
				AND d.status = 'active'
				AND ls.system_config->'modbus_config' IS NOT NULL
				AND ls.system_config->'modbus_config' != '{}'::jsonb
		`);

    if (areas.length === 0) {
      return;
    }

    let successCount = 0;
    let failCount = 0;

    // 併發控制由 modbusClient（全域 limiter）統一處理
    const checkPromises = areas.map(async (area) => {
      try {
        // 解析 modbus 配置
        const modbusConfigRaw =
          typeof area.modbus_config === "string"
            ? JSON.parse(area.modbus_config)
            : area.modbus_config;

        if (!modbusConfigRaw || Object.keys(modbusConfigRaw).length === 0) {
          return {
            systemId: area.system_id,
            areaId: area.location_id,
            success: false,
            reason: "配置為空",
          };
        }

        let deviceConfig = null;

        // 如果使用新格式（有 device_id 且 device_config 存在）
        if (area.device_id && area.device_config) {
          const config =
            typeof area.device_config === "string"
              ? JSON.parse(area.device_config)
              : area.device_config;

          if (config.host && config.port !== undefined) {
            deviceConfig = {
              host: config.host,
              port: config.port,
              unitId: config.unitId || 1,
            };
          }
        } else if (modbusConfigRaw.host && modbusConfigRaw.port !== undefined) {
          // 向後兼容：使用舊格式（從 modbus_config 直接讀取）
          deviceConfig = {
            host: modbusConfigRaw.host,
            port: modbusConfigRaw.port,
            unitId: modbusConfigRaw.unitId || 1,
          };
        }

        if (!deviceConfig) {
          return {
            systemId: area.system_id,
            areaId: area.location_id,
            success: false,
            reason: "配置不完整",
          };
        }

        // 嘗試讀取第一個離散輸入或線圈來檢查設備狀態
        // 優先使用 DI（離散輸入），因為它反映實際設備狀態
        const diAddresses =
          modbusConfigRaw.points
            ?.filter((p) => p.type === "di")
            .map((p) => p.address) || [];
        const doAddresses =
          modbusConfigRaw.points
            ?.filter((p) => p.type === "do")
            .map((p) => p.address) || [];
        const address =
          diAddresses.length > 0
            ? diAddresses[0]
            : doAddresses.length > 0
              ? doAddresses[0]
              : 0;

        const registerType = diAddresses.length > 0 ? "discrete" : "coil";
        const safeAddress = Number.isFinite(address) ? address : 0;

        const results = await modbusBatchService.batchRead([
          {
            host: deviceConfig.host,
            port: deviceConfig.port,
            unitId: deviceConfig.unitId,
            registerType,
            address: safeAddress,
            length: 1,
            meta: { systemId: area.system_id },
          },
        ]);

        const first = results?.[0];
        if (!first || first.ok !== true) {
          throw new Error(first?.error || "無法讀取照明設備資料");
        }

        await systemAlert.syncLocationSnapshotReadResult(
          "lighting",
          area.system_id,
          true,
        );

        // 照明系統以警報為主要紀錄方式，不進行定期資料記錄
        return {
          systemId: area.system_id,
          areaId: area.location_id,
          success: true,
        };
      } catch (error) {
        // 讀取失敗，記錄錯誤（批次模式：跳過即時推送）
        // 使用 location_systems.id 作為 source_id
        const errorMessage = error.message || "無法讀取照明設備資料";
        await systemAlert.syncLocationSnapshotReadResult(
          "lighting",
          area.system_id,
          false,
          errorMessage,
        );

        return {
          systemId: area.system_id,
          areaId: area.location_id,
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
        const areaId = result.value.areaId;
        const key = `lighting:${systemId}`;
        const currentStatus = result.value.success ? "online" : "offline";
        const lastStatus = lastDeviceStatus.get(key);

        // 從原始 areas 陣列中獲取 device_id
        const area = areas[index];
        const deviceId = area?.device_id ? parseInt(area.device_id) : null;

        // 只在狀態改變時才添加到更新列表
        if (lastStatus !== currentStatus) {
          lastDeviceStatus.set(key, currentStatus);

          if (result.value.success) {
            successCount++;
            statusUpdates.push({
              system: "lighting",
              sourceId: systemId,
              deviceId: deviceId,
              status: "online",
            });
          } else {
            failCount++;
            statusUpdates.push({
              system: "lighting",
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
        const area = areas[index];
        if (area) {
          const key = `lighting:${area.system_id}`;
          const lastStatus = lastDeviceStatus.get(key);

          // 只在狀態改變時才推送
          if (lastStatus !== "offline") {
            lastDeviceStatus.set(key, "offline");
            statusUpdates.push({
              system: "lighting",
              sourceId: area.system_id,
              deviceId: area.device_id ? parseInt(area.device_id) : null,
              status: "offline",
            });
          }
        }
        logger.error("檢查區域失敗 (Promise rejected)", {
          error: result.reason?.message || result.reason,
          areaId: area?.location_id,
          module: "lightingMonitor",
        });
      }
    });

    // 批次推送設備狀態更新（只推送狀態改變的設備）
    if (statusUpdates.length > 0) {
      websocketService.emitBatchDeviceStatus(statusUpdates);
    }

    const hasMeaningfulChange = statusUpdates.length > 0 || failCount > 0;
    const summary = `檢查完成: 成功 ${successCount} 個，失敗 ${failCount} 個`;
    if (hasMeaningfulChange) {
      logger.info(summary, {
        successCount,
        failCount,
        statusUpdates: statusUpdates.length,
        module: "lightingMonitor",
      });
    } else {
      // `logger.debug` 在 production 預設不輸出（除非 ENABLE_DEBUG_LOGS=true）
      logger.debug(summary, {
        successCount,
        failCount,
        module: "lightingMonitor",
      });
    }
  } catch (error) {
    logger.error("檢查照明區域失敗", {
      error,
      module: "lightingMonitor",
    });
    // 不重新拋出錯誤，由 backgroundMonitor 統一處理
  }
}

module.exports = {
  checkLightingAreas,
};
