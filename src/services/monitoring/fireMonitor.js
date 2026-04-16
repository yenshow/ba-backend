/**
 * 消防系統監控任務
 * 定期讀取所有消防點位狀態，並推送連線狀態（monitoring:device:status:batch）
 * - 連線類警報由 statusService 經 systemAlertHelper.syncLocationSnapshotReadResult 處理
 * - DI/DO（bit_state）警報統一由 diDoMonitor 處理
 */

const logger = require("../../utils/logger");
const fireStatusService = require("../systems/fireStatusService");
const websocketService = require("../websocket/websocketService");

const lastDeviceStatus = new Map();

async function checkFireSystems() {
  const monitorLogger = logger.createLogger("fireMonitor");
  try {
    const { items } = await fireStatusService.getStatusSnapshot();

    const statusUpdates = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        const systemId = item.systemId;
        if (!systemId) continue;

        const currentStatus = item.error ? "offline" : "online";
        const key = `fire:${systemId}`;
        const lastStatus = lastDeviceStatus.get(key);

        if (lastStatus !== currentStatus) {
          lastDeviceStatus.set(key, currentStatus);
          statusUpdates.push({
            system: "fire",
            sourceId: Number(systemId),
            deviceId: null,
            status: currentStatus,
          });
        }
      }
    }

    if (statusUpdates.length > 0) {
      websocketService.emitBatchDeviceStatus(statusUpdates);
    }
  } catch (error) {
    monitorLogger.warn("消防監控執行失敗（不影響其他任務）", {
      error: error?.message || String(error),
    });
  }
}

module.exports = {
  checkFireSystems,
};
