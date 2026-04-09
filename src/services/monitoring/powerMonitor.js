/**
 * 電力系統監控任務：定期讀取狀態並推送連線狀態
 */

const logger = require("../../utils/logger");
const powerStatusService = require("../systems/powerStatusService");
const websocketService = require("../websocket/websocketService");

const lastDeviceStatus = new Map();

async function checkPowerSystems() {
  const monitorLogger = logger.createLogger("powerMonitor");
  try {
    const { items } = await powerStatusService.getStatusSnapshot();

    const statusUpdates = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        const systemId = item.systemId;
        if (!systemId) continue;

        const currentStatus = item.error ? "offline" : "online";
        const key = `power:${systemId}`;
        const lastStatus = lastDeviceStatus.get(key);

        if (lastStatus !== currentStatus) {
          lastDeviceStatus.set(key, currentStatus);
          statusUpdates.push({
            system: "power",
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
    monitorLogger.warn("電力監控執行失敗（不影響其他任務）", {
      error: error?.message || String(error),
    });
  }
}

module.exports = {
  checkPowerSystems,
};
