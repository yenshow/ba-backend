/**
 * 緊急求救：背景巡檢（讀取狀態並同步連線類警報）
 */

const logger = require("../../utils/logger");
const emergencyRescueStatusService = require("../systems/emergencyRescueStatusService");
const websocketService = require("../websocket/websocketService");

const lastDeviceStatus = new Map();

async function checkEmergencyRescueSystems() {
  const monitorLogger = logger.createLogger("emergencyRescueMonitor");
  try {
    const { items } = await emergencyRescueStatusService.getStatusSnapshot();

    const statusUpdates = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        const systemId = item.systemId;
        if (!systemId) continue;

        const currentStatus = item.error ? "offline" : "online";
        const key = `emergency_rescue:${systemId}`;
        const lastStatus = lastDeviceStatus.get(key);

        if (lastStatus !== currentStatus) {
          lastDeviceStatus.set(key, currentStatus);
          statusUpdates.push({
            system: "emergency_rescue",
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
    monitorLogger.warn("緊急求救監控執行失敗（不影響其他任務）", {
      error: error?.message || String(error),
    });
  }
}

module.exports = {
  checkEmergencyRescueSystems,
};
