/**
 * 系統快照監控：通用 online/offline 推送 wrapper
 *
 * 供 drainage/power/fire/emergency_rescue/hvac/air_circulation 等「有 statusService.getStatusSnapshot」的系統共用。
 * - statusService 內部負責：讀取點位、同步連線類警報（syncLocationSnapshotReadResult）
 * - monitor 這層負責：把 online/offline 變化推送到 websocket（monitoring:device:status:batch）
 */

const logger = require("../../utils/logger");
const websocketService = require("../websocket/websocketService");

/**
 * @param {object} options
 * @param {string} options.systemKey - e.g. "drainage" | "power" | "fire" | "emergency_rescue"
 * @param {string} options.loggerName - e.g. "drainageMonitor"
 * @param {() => Promise<{ items?: any[] }>} options.getSnapshot - usually statusService.getStatusSnapshot
 * @param {(item: any) => string|null|undefined} [options.getSystemId] - default: item.systemId
 * @param {(item: any) => number|null|undefined} [options.getDeviceId] - default: null
 * @param {(item: any) => boolean} [options.isOnline] - default: !item.error
 */
function createSystemSnapshotMonitor(options) {
  const {
    systemKey,
    loggerName,
    getSnapshot,
    getSystemId = (item) => item?.systemId,
    getDeviceId = () => null,
    isOnline = (item) => !item?.error,
  } = options || {};

  if (!systemKey) throw new Error("systemKey is required");
  if (!loggerName) throw new Error("loggerName is required");
  if (typeof getSnapshot !== "function") throw new Error("getSnapshot must be a function");

  const monitorLogger = logger.createLogger(loggerName);
  const lastDeviceStatus = new Map(); // key: `${systemKey}:${sourceId}` -> 'online' | 'offline'

  const check = async () => {
    try {
      const { items } = await getSnapshot();
      const statusUpdates = [];

      if (Array.isArray(items)) {
        for (const item of items) {
          const systemId = getSystemId(item);
          if (!systemId) continue;

          const currentStatus = isOnline(item) ? "online" : "offline";
          const key = `${systemKey}:${systemId}`;
          const lastStatus = lastDeviceStatus.get(key);

          if (lastStatus !== currentStatus) {
            lastDeviceStatus.set(key, currentStatus);
            statusUpdates.push({
              system: systemKey,
              sourceId: Number(systemId),
              deviceId: getDeviceId(item) ?? null,
              status: currentStatus,
            });
          }
        }
      }

      if (statusUpdates.length > 0) {
        websocketService.emitBatchDeviceStatus(statusUpdates);
      }
    } catch (error) {
      monitorLogger.warn(`${systemKey} 監控執行失敗（不影響其他任務）`, {
        error: error?.message || String(error),
      });
    }
  };

  return { check };
}

module.exports = {
  createSystemSnapshotMonitor,
};

